// Deterministic pre-AI question router. The goal: answer as much as possible
// without ever calling an AI provider. AI is the last resort, not the first.
import { supabaseAdmin } from "./supabase-admin.ts";

export function normalizeQuestion(question) {
  return question.trim().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// 1. Calculation - pure arithmetic needs no AI and no data lookup at all.
// ---------------------------------------------------------------------------

const CALC_PATTERN =
  /-?\d+(?:\.\d+)?\s*(?:[+\-*/]\s*-?\d+(?:\.\d+)?\s*)+/;

// Tiny, safe recursive-descent evaluator - never uses eval()/Function().
function evaluateArithmetic(expr) {
  let pos = 0;

  function peek() {
    return expr[pos];
  }
  function skipSpace() {
    while (peek() === " ") pos++;
  }
  function parseNumber() {
    skipSpace();
    const start = pos;
    if (peek() === "-") pos++;
    while (/[0-9.]/.test(peek() || "")) pos++;
    if (pos === start) throw new Error("Expected number");
    return parseFloat(expr.slice(start, pos));
  }
  function parseFactor() {
    skipSpace();
    if (peek() === "(") {
      pos++;
      const value = parseExpr();
      skipSpace();
      if (peek() !== ")") throw new Error("Expected )");
      pos++;
      return value;
    }
    return parseNumber();
  }
  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      skipSpace();
      const op = peek();
      if (op === "*" || op === "/") {
        pos++;
        const rhs = parseFactor();
        value = op === "*" ? value * rhs : value / rhs;
      } else break;
    }
    return value;
  }
  function parseExpr() {
    let value = parseTerm();
    for (;;) {
      skipSpace();
      const op = peek();
      if (op === "+" || op === "-") {
        pos++;
        const rhs = parseTerm();
        value = op === "+" ? value + rhs : value - rhs;
      } else break;
    }
    return value;
  }

  const result = parseExpr();
  skipSpace();
  if (pos !== expr.length) throw new Error("Unexpected trailing input");
  return result;
}

export function tryCalculation(question) {
  const match = question.match(CALC_PATTERN);
  if (!match) return null;

  // Require the expression to actually contain an operator (reject bare numbers).
  if (!/[+\-*/]/.test(match[0])) return null;

  try {
    const result = evaluateArithmetic(match[0]);
    if (!Number.isFinite(result)) return null;
    return {
      answer: `${match[0].trim()} = ${result}`,
      intent: "calculation",
      sourceUsed: "calculator",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 2. Document metadata lookups - deterministic DB queries, no AI needed.
// ---------------------------------------------------------------------------

export async function tryDocumentMetaLookup(question) {
  const uploadMatch = question.match(
    /when\s+was\s+(?:the\s+)?(.+?)\s+uploaded\??$/i,
  );
  if (uploadMatch) {
    const term = uploadMatch[1].trim();
    const { data } = await supabaseAdmin
      .from("documents")
      .select("name, created_at")
      .ilike("name", `%${term}%`)
      .limit(1)
      .maybeSingle();

    if (data) {
      return {
        answer: `"${data.name}" was uploaded on ${
          new Date(data.created_at).toLocaleDateString()
        }.`,
        intent: "document_upload_date",
        sourceUsed: "documents_table",
      };
    }
  }

  const pageMatch = question.match(
    /what\s+page\s+is\s+(.+?)\s+on\??$/i,
  );
  if (pageMatch) {
    const term = pageMatch[1].trim();
    const { data } = await supabaseAdmin
      .from("document_chunks")
      .select("page_number, document_id")
      .ilike("content", `%${term}%`)
      .not("page_number", "is", null)
      .order("chunk_index", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (data) {
      const { data: doc } = await supabaseAdmin
        .from("documents")
        .select("name")
        .eq("id", data.document_id)
        .maybeSingle();

      return {
        answer: `"${term}" appears on page ${data.page_number}${
          doc ? ` of "${doc.name}"` : ""
        }.`,
        intent: "document_page_lookup",
        sourceUsed: "keyword_search",
      };
    }
  }

  const showMatch = question.match(
    /^(?:show me|find|open|do we have)\s+(?:the\s+)?(.+?)(?:\s+(?:manual|document|schedule|spec|drawing))?\??$/i,
  );
  if (showMatch) {
    const term = showMatch[1].trim();
    if (term.length >= 3) {
      const { data } = await supabaseAdmin
        .from("documents")
        .select("name, category, status, created_at")
        .ilike("name", `%${term}%`)
        .limit(5);

      if (data?.length) {
        const list = data
          .map((d) => `- ${d.name}${d.category ? ` (${d.category})` : ""}`)
          .join("\n");
        return {
          answer: `Found ${data.length} matching document(s):\n${list}`,
          intent: "document_listing",
          sourceUsed: "documents_table",
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. Direct fact extraction - cheap keyword search + regex, no AI reasoning.
// ---------------------------------------------------------------------------

const FACT_PATTERNS = [
  {
    intent: "part_number_lookup",
    trigger: /part\s*(?:no\.?|number|#)/i,
    extract: /part\s*(?:no\.?|number|#)\s*[:-]?\s*([A-Za-z0-9-]{2,})/i,
  },
  {
    intent: "quantity_lookup",
    trigger: /how many\s+(\w+)/i,
    extract: /(\d+)\s+[\w-]+/,
  },
  {
    intent: "manufacturer_lookup",
    trigger: /(?:what|which)\s+manufacturer/i,
    extract: /manufactured\s+by\s+([A-Za-z0-9 &.-]{2,40})/i,
  },
];

export async function tryDirectFactExtraction(question) {
  const pattern = FACT_PATTERNS.find((p) => p.trigger.test(question));
  if (!pattern) return null;

  // Pull the subject keywords (strip common question words) for the search.
  const keywords = question
    .replace(
      /\b(what|which|how|many|is|are|the|for|of|a|an|part|number|no|manufacturer)\b/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (keywords.length < 2) return null;

  const { data } = await supabaseAdmin
    .from("document_chunks")
    .select("content, page_number, document_id")
    .ilike("content", `%${keywords}%`)
    .limit(3);

  if (!data?.length) return null;

  for (const chunk of data) {
    const match = chunk.content.match(pattern.extract);
    if (match) {
      const { data: doc } = await supabaseAdmin
        .from("documents")
        .select("name")
        .eq("id", chunk.document_id)
        .maybeSingle();

      return {
        answer: `${match[1]}${
          doc ? ` (source: ${doc.name}, page ${chunk.page_number ?? "?"})` : ""
        }`,
        intent: pattern.intent,
        sourceUsed: "keyword_search+extraction",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Telemetry - never let logging failures break the actual response.
// ---------------------------------------------------------------------------

export async function logAiUsage(entry) {
  try {
    await supabaseAdmin.from("ai_usage").insert(entry);
  } catch (err) {
    console.error("ai_usage logging failed (ignored):", err);
  }
}

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
