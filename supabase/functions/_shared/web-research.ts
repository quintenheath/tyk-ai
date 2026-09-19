import { supabaseAdmin } from "./supabase-admin.ts";

const GEMINI_SEARCH_MODEL = Deno.env.get("GEMINI_SEARCH_MODEL") ||
  Deno.env.get("GEMINI_MODEL") || "gemini-3.6-flash";
const STOP_WORDS = new Set([
  "about", "after", "does", "from", "have", "help", "how", "into",
  "what", "when", "where", "which", "with", "would", "your",
]);

const CODE_SOURCES = [
  {
    url: "https://www.ontario.ca/laws/regulation/120332",
    title: "Ontario Building Code",
    domain: "ontario.ca",
    sourceType: "government",
  },
  {
    url: "https://www.ontario.ca/laws/regulation/070213",
    title: "Ontario Fire Code",
    domain: "ontario.ca",
    sourceType: "government",
  },
];

export function isFireCodeQuestion(question) {
  return /fire[- ]rated|fire door|fire[- ]door assembly|fire opening|rated opening|rated door|fire separation|fire exit|panic hardware|exit hardware|latching hardware|self[- ]closing|positive latching|fire rating|hourly rating|\b(?:20|45|60|90|180)[ -]?minute\b|fire code|building code|ontario (?:building|fire) code|\bnfpa\b|\bulc?\b|can\/ulc|listed hardware|labeled hardware|closer/i.test(question);
}

function cleanTerm(term) {
  return term.replace(/[^a-z0-9-]/gi, "").toLowerCase();
}

function questionTerms(question) {
  return [...new Set(
    question
      .split(/\s+/)
      .map(cleanTerm)
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
  )].slice(0, 8);
}

function buildSearchQueries(question) {
  const clean = question.trim().replace(/[?!.]+$/, "");
  const designation = clean.match(/\b(?:what is|what are|tell me about)\s+([a-z0-9-]+)\b/i)?.[1];
  const queries = [clean];
  if (isFireCodeQuestion(clean)) {
    queries.push(
      `${clean} Ontario fire rated door hardware requirements`,
      `${clean} Ontario Building Code fire door hardware`,
      `${clean} Ontario Fire Code fire door hardware`,
      `${clean} self closing latching hardware fire separation`,
      `${clean} listed labeled hardware ULC fire door assembly`,
    );
    return [...new Set(queries)].slice(0, 6);
  }
  if (designation && /^\d+[a-z0-9-]*$/i.test(designation)) {
    queries.push(
      `${designation} commercial door hardware`,
      `${designation} exit device`,
      `${designation} door hardware manufacturer`,
      `${designation} installation manual`,
    );
  } else {
    queries.push(`${clean} official documentation`, `${clean} manufacturer technical information`);
  }
  return [...new Set(queries)].slice(0, 5);
}

function parseJsonAnswer(text) {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function fallbackTitle(question) {
  const cleaned = question
    .replace(/^(what is|what are|who is|where is|how does|how do|can you explain)\s+/i, "")
    .replace(/[?.!]+$/, "")
    .trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Web research";
}

function normalizeSources(groundingChunks, groundingSupports) {
  return (groundingChunks || [])
    .map((chunk, index) => ({ web: chunk?.web, index }))
    .filter((chunk) => chunk.web)
    .map(({ web, index }) => ({
      url: web.uri,
      title: web.title || web.uri,
      domain: (() => {
        try {
          return new URL(web.uri).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      })(),
      evidenceText: (groundingSupports || [])
        .filter((support) => support.groundingChunkIndices?.includes(index))
        .map((support) => support.segment?.text)
        .filter(Boolean)
        .join(" ")
        .slice(0, 2000),
    }))
    .filter((source) => source?.url)
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 8);
}

function authoritativeRank(domain) {
  if (!domain) return 0;
  if (/\.gov$|\.gov\.|\.gc\.ca$|\.gc\.ca\//i.test(domain)) return 7;
  if (/ontario\.ca|nfpa\.org|ul\.com|ulc\.ca|codes\.icc\.cs/i.test(domain)) return 7;
  if (/allegion|vonduprin|lcnhardware|assaabloy|dormakaba|hager|ives|rockwood/i.test(domain)) return 6;
  if (/manufacturer|supplier|distributor/i.test(domain)) return 5;
  return 1;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return stripHtml(await response.text());
  } finally {
    clearTimeout(timeout);
  }
}

function relevantEvidence(text, question) {
  const terms = questionTerms(question).filter((term) => term.length > 3);
  const matches = [];
  for (const term of terms) {
    const index = text.toLowerCase().indexOf(term);
    if (index >= 0) matches.push(text.slice(Math.max(0, index - 220), index + 620));
  }
  return [...new Set(matches)].slice(0, 4).join("\n\n").slice(0, 3000);
}

export async function researchKnownAuthoritativeSource(question) {
  if (!isFireCodeQuestion(question)) return null;

  const sources = [];
  for (const source of CODE_SOURCES) {
    const text = await fetchText(source.url);
    if (!text) continue;
    const evidence = relevantEvidence(text, question) || text.slice(0, 1800);
    sources.push({
      ...source,
      url: source.url,
      title: source.title,
      evidenceText: evidence,
      authoritative: true,
    });
  }
  if (!sources.length) return null;

  const sourceList = sources.map((source) => `- ${source.title}: ${source.url}`).join("\n");
  return {
    answer: `I found the current Ontario Building Code and Ontario Fire Code sources. The exact hardware requirements depend on the opening's fire-resistance rating, use/egress function, labeled/listed assembly, and applicable code edition. Relevant retrieved evidence:\n\n${sources.map((source) => `${source.title}:\n${source.evidenceText}`).join("\n\n")}`,
    title: "Ontario Fire-Rated Opening Hardware Requirements",
    topicSummary: "Research into Ontario fire-rated opening hardware requirements, including rating, self-closing, latching, egress, and listed assembly conditions.",
    topic: "Ontario fire-rated opening hardware requirements",
    entityName: null,
    confidence: "medium",
    facts: [],
    ambiguity: "The retrieved code pages identify the governing sources, but the exact hardware list depends on the opening rating, use, and assembly details.",
    searchQueries: buildSearchQueries(question),
    sources,
    provider: "official_ontario_sources",
    model: "deterministic_source_fetch",
    sourceList,
  };
}

function sortSources(sources) {
  return [...sources].sort((a, b) => authoritativeRank(b.domain) - authoritativeRank(a.domain));
}

export async function findSavedWebSource(question) {
  const terms = questionTerms(question);
  if (terms.length === 0) return null;

  const candidates = new Map();
  for (const term of terms) {
    const pattern = `%${term}%`;
    const { data, error } = await supabaseAdmin
      .from("web_sources")
      .select("id, url, title, domain, snippet, topic, entity_name, answer, confidence, source_type, authoritative, retrieved_at")
      .or(`topic.ilike.${pattern},title.ilike.${pattern},snippet.ilike.${pattern},answer.ilike.${pattern}`)
      .order("retrieved_at", { ascending: false })
      .limit(10);
    if (error) {
      console.error("Saved web-source search failed (continuing):", error);
      return null;
    }
    for (const source of data || []) {
      const score = (candidates.get(source.id)?.score || 0) + 1 + (source.authoritative ? 0.5 : 0);
      candidates.set(source.id, { source, score });
    }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score)[0]?.source || null;
}

export async function researchWeb(question, context = {}) {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return null;

  const searchQueries = context.searchQueries || buildSearchQueries(question);
  const prompt = `Research this public-web question for TYK using Google Search grounding.
Prefer authoritative sources in this order: government, official code or standards organization, manufacturer, supplier, authorized technical source, reputable industry source, general web result.
Run or consider these generated search queries: ${searchQueries.join(" | ")}
Do not guess or silently merge conflicting facts. Use only facts supported by the returned sources. If sources disagree, describe the conflict instead of picking silently.
Return JSON only with these fields:
{"answer":"concise answer with source-aware wording","title":"specific conversation title","topic_summary":"one or two sentence topic summary","topic":"short research topic","entity_name":"product, manufacturer, or null","confidence":"high|medium|low","facts":[{"claim":"fact","value":"value","source_url":"url or null"}],"ambiguity":"none or concise ambiguity/conflict description"}
Question: ${question}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SEARCH_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
    },
  );

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error?.message || "Web research failed.");
    error.status = response.status;
    throw error;
  }

  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) return null;

  const parsed = parseJsonAnswer(text) || {};
  const groundingMetadata = candidate?.groundingMetadata || {};
  const sources = sortSources(normalizeSources(
    groundingMetadata.groundingChunks,
    groundingMetadata.groundingSupports,
  ));
  if (sources.length === 0) return null;

  return {
    answer: parsed.answer || text,
    title: parsed.title || fallbackTitle(question),
    topicSummary: parsed.topic_summary || `Research about ${parsed.topic || fallbackTitle(question)}.`,
    topic: parsed.topic || fallbackTitle(question),
    entityName: parsed.entity_name || null,
    confidence: parsed.confidence || "medium",
    facts: Array.isArray(parsed.facts) ? parsed.facts.slice(0, 20) : [],
    ambiguity: parsed.ambiguity || null,
    searchQueries,
    sources,
    provider: "gemini_google_search",
    model: GEMINI_SEARCH_MODEL,
  };
}

export async function saveWebResearch(research, conversationId = null) {
  if (!research?.sources?.length) return;
  const retrievedAt = new Date().toISOString();
  let entityId = null;
  if (research.entityName) {
    const { data: entity } = await supabaseAdmin
      .from("knowledge_entities")
      .select("id")
      .ilike("name", research.entityName)
      .maybeSingle();
    entityId = entity?.id || null;
  }

  for (const source of research.sources) {
    try {
      await supabaseAdmin.from("web_sources").upsert({
        url: source.url,
        title: source.title,
        domain: source.domain,
        retrieved_at: retrievedAt,
        snippet: research.answer.slice(0, 1200),
        evidence_text: source.evidenceText || research.answer.slice(0, 2000),
        extracted_facts: research.facts || [],
        search_query: research.searchQueries?.join("\n") || research.topic,
        authoritative: authoritativeRank(source.domain) >= 6,
        topic: research.topic,
        entity_id: entityId,
        entity_name: research.entityName,
        answer: research.answer,
        confidence: research.confidence,
        source_type: authoritativeRank(source.domain) >= 7
          ? "government"
          : authoritativeRank(source.domain) >= 6
          ? "manufacturer"
          : "web_search",
        provider: research.provider,
        conversation_id: conversationId,
        knowledge_state: "SOURCE_BACKED",
        updated_at: retrievedAt,
      }, { onConflict: "url,topic" });
    } catch (error) {
      console.error("Failed to save web source (ignored):", error);
    }
  }

  if (research.ambiguity && research.sources.length >= 2) {
    try {
      await supabaseAdmin.from("web_source_conflicts").insert({
        entity_name: research.entityName,
        topic: research.topic,
        source_a_url: research.sources[0].url,
        source_b_url: research.sources[1].url,
        source_a_claim: research.answer,
        source_b_claim: research.ambiguity,
        status: "NEEDS_REVIEW",
      });
    } catch (error) {
      console.error("Failed to save web-source conflict (ignored):", error);
    }
  }

  if (isFireCodeQuestion(research.topic || "")) {
    const followups = [
      "Research Ontario fire door assembly self-closing requirements",
      "Research Ontario fire door positive latching requirements",
      "Research Ontario fire-rated opening exit hardware requirements",
      "Research Ontario panic and fire exit hardware requirements",
      "Research Ontario electrified hardware on fire-rated openings",
      "Research Ontario ULC and labeled fire door assembly requirements",
      "Research Ontario fire door inspection and maintenance requirements",
    ];
    const { data: existing } = await supabaseAdmin
      .from("research_queue")
      .select("topic")
      .in("topic", followups);
    const known = new Set((existing || []).map((task) => task.topic));
    for (const title of followups) {
      if (known.has(title)) continue;
      await supabaseAdmin.from("research_queue").insert({
        topic: title,
        title,
        description: "Follow-up evidence research generated from an Ontario fire/code question.",
        type: "RESEARCH",
        priority: 9,
        source_type: "government",
        search_queries: [title, "Ontario Building Code", "Ontario Fire Code"],
        reason: "Fire/life-safety research has higher priority and requires authoritative evidence.",
        status: "queued",
      });
    }
  }
}
