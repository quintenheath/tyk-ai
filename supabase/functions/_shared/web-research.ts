import { supabaseAdmin } from "./supabase-admin.ts";

const GEMINI_SEARCH_MODEL = Deno.env.get("GEMINI_SEARCH_MODEL") ||
  Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
const STOP_WORDS = new Set([
  "about", "after", "does", "from", "have", "help", "how", "into",
  "what", "when", "where", "which", "with", "would", "your",
]);

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

function normalizeSources(groundingChunks) {
  return (groundingChunks || [])
    .map((chunk) => chunk?.web)
    .filter((source) => source?.uri)
    .map((source) => ({
      url: source.uri,
      title: source.title || source.uri,
      domain: (() => {
        try {
          return new URL(source.uri).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
      })(),
    }))
    .filter((source, index, all) => all.findIndex((item) => item.url === source.url) === index)
    .slice(0, 8);
}

function authoritativeRank(domain) {
  if (!domain) return 0;
  if (/\.gov$|\.gov\.|\.gc\.ca$|\.gc\.ca\//i.test(domain)) return 7;
  if (/allegion|vonduprin|lcnhardware|assaabloy|dormakaba|hager|ives|rockwood/i.test(domain)) return 6;
  if (/manufacturer|supplier|distributor/i.test(domain)) return 5;
  return 1;
}

function sortSources(sources) {
  return [...sources].sort((a, b) => authoritativeRank(b.domain) - authoritativeRank(a.domain));
}

export async function findSavedWebSource(question) {
  const terms = questionTerms(question);
  if (terms.length === 0) return null;

  for (const term of terms) {
    const pattern = `%${term}%`;
    const { data, error } = await supabaseAdmin
      .from("web_sources")
      .select("id, url, title, domain, snippet, topic, entity_name, answer, confidence, source_type")
      .or(`topic.ilike.${pattern},title.ilike.${pattern},snippet.ilike.${pattern},answer.ilike.${pattern}`)
      .order("retrieved_at", { ascending: false })
      .limit(3);
    if (error) {
      console.error("Saved web-source search failed (continuing):", error);
      return null;
    }
    if (data?.length) return data[0];
  }
  return null;
}

export async function researchWeb(question) {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return null;

  const prompt = `Research this public-web question for TYK using Google Search grounding.
Prefer authoritative sources in this order: government, official code or standards organization, manufacturer, supplier, authorized technical source, reputable industry source, general web result.
Do not guess or silently merge conflicting facts. Use only facts supported by the returned sources.
Return JSON only with these fields:
{"answer":"concise answer with source-aware wording","title":"specific conversation title","topic_summary":"one or two sentence topic summary","topic":"short research topic","entity_name":"product, manufacturer, or null","confidence":"high|medium|low"}
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
  const sources = sortSources(normalizeSources(candidate?.groundingMetadata?.groundingChunks));
  if (sources.length === 0) return null;

  return {
    answer: parsed.answer || text,
    title: parsed.title || fallbackTitle(question),
    topicSummary: parsed.topic_summary || `Research about ${parsed.topic || fallbackTitle(question)}.`,
    topic: parsed.topic || fallbackTitle(question),
    entityName: parsed.entity_name || null,
    confidence: parsed.confidence || "medium",
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
        updated_at: retrievedAt,
      }, { onConflict: "url,topic" });
    } catch (error) {
      console.error("Failed to save web source (ignored):", error);
    }
  }
}
