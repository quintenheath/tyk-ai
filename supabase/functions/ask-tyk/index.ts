import { generateAnswer } from "../_shared/ai-router.ts";
import { embedText } from "../_shared/embeddings.ts";
import { supabaseAdmin } from "../_shared/supabase-admin.ts";
import {
  findReusableAnswer,
  markAnswerReused,
  saveLearnedAnswer,
} from "../_shared/learned-knowledge.ts";
import { getActiveConnector } from "../_shared/connected-sources/registry.ts";
import { SourceNotConnectedError } from "../_shared/connected-sources/types.ts";
import {
  findSavedWebSource,
  isBoilerplate,
  isFireCodeQuestion,
  researchKnownAuthoritativeSource,
  researchWeb,
  saveWebResearch,
} from "../_shared/web-research.ts";
import {
  estimateTokens,
  logAiUsage,
  normalizeQuestion,
  tryCalculation,
  tryDirectFactExtraction,
  tryDocumentMetaLookup,
} from "../_shared/router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MAX_KNOWLEDGE_CHUNKS = 6;
const RELIABLE_KNOWLEDGE_SIMILARITY = 0.72;

// Deterministic domain -> connected source mapping. No AI needed to know
// that a fire-code question should check NFPA LiNK before falling through.
const CONNECTED_SOURCE_DOMAINS = [
  { pattern: /\bnfpa\b|fire code|fire-rated|fire door assembly|fire rated/i, provider: "nfpa_link" },
];

// Tries an authenticated Connected Source before AI, per the routing rule:
// fire code question -> TYK knowledge -> connected source -> AI. Silently
// no-ops (returns null) whenever the source isn't actually connected, so
// this is a pure addition with zero regression risk until a source is wired.
async function tryConnectedSource(question) {
  const match = CONNECTED_SOURCE_DOMAINS.find((d) => d.pattern.test(question));
  if (!match) return null;

  const connector = await getActiveConnector(match.provider);
  if (!connector) return null;

  try {
    const results = await connector.search(question);
    if (!results.length) return null;

    const top = results[0];
    const doc = await connector.read(top.reference);

    return {
      answer: doc.content,
      citation: doc.citation,
      provider: connector.provider,
    };
  } catch (err) {
    if (!(err instanceof SourceNotConnectedError)) {
      console.error(`Connected source "${match.provider}" search failed:`, err);
    }
    return null;
  }
}

// Finds the most relevant knowledge-base chunks for the question (RAG).
// Reuses an already-computed embedding so the question is only embedded once.
async function searchKnowledge(embedding) {
  if (!embedding) return [];
  try {
    const { data, error } = await supabaseAdmin.rpc("match_document_chunks", {
      query_embedding: embedding,
      match_count: MAX_KNOWLEDGE_CHUNKS,
    });
    if (error) throw error;
    if (!data?.length) return [];

    const documentIds = [...new Set(data.map((row) => row.document_id))];
    const { data: docs } = await supabaseAdmin
      .from("documents")
      .select("id, name")
      .in("id", documentIds);
    const nameById = Object.fromEntries(
      (docs || []).map((d) => [d.id, d.name]),
    );

    return data.map((row) => ({
      documentId: row.document_id,
      documentName: nameById[row.document_id] || "Unknown document",
      page: row.page_number,
      content: row.content,
      similarity: row.similarity,
    }));
  } catch (err) {
    console.error("Knowledge search failed (continuing without it):", err);
    return [];
  }
}

// Pulls the full extracted text of explicitly attached documents (e.g. a
// hardware schedule the user wants fully analyzed, not just top-k matches).
async function loadAttachedDocuments(documentIds) {
  if (!documentIds?.length) return [];

  const { data: docs } = await supabaseAdmin
    .from("documents")
    .select("id, name")
    .in("id", documentIds);

  const results = [];
  for (const doc of docs || []) {
    const { data: chunks } = await supabaseAdmin
      .from("document_chunks")
      .select("page_number, chunk_index, content")
      .eq("document_id", doc.id)
      .order("chunk_index", { ascending: true });

    const fullText = (chunks || [])
      .map((c) => `[Page ${c.page_number}] ${c.content}`)
      .join("\n");

    results.push({ documentId: doc.id, documentName: doc.name, fullText });
  }
  return results;
}

// When AI is genuinely unavailable, prefer returning verified information TYK
// already has over a flat refusal - the user should never know AI failed.
function buildPartialAnswer(knowledgeChunks) {
  if (!knowledgeChunks.length) return null;
  const top = knowledgeChunks.slice(0, 2);
  const excerpts = top
    .map((c) => `From "${c.documentName}" (page ${c.page ?? "?"}): ${c.content}`)
    .join("\n\n");
  return `Here's what I have on file:\n\n${excerpts}`;
}

function decideWebResearch(isPlainTextQuestion, knowledgeChunks) {
  if (!isPlainTextQuestion) {
    return {
      needsWebResearch: false,
      reason: "Images or attached documents require their own reasoning path.",
    };
  }

  const bestSimilarity = knowledgeChunks[0]?.similarity || 0;
  if (bestSimilarity >= RELIABLE_KNOWLEDGE_SIMILARITY) {
    return {
      needsWebResearch: false,
      reason: "TYK found a reliable internal knowledge match.",
    };
  }

  return {
    needsWebResearch: true,
    reason: knowledgeChunks.length
      ? "Internal matches were below the reliability threshold."
      : "No relevant internal knowledge was found.",
  };
}

function contextualResearchQuestion(question, history) {
  const clean = question.trim();
  const isFollowUp = clean.length < 80 || /^(what about|how about|why|how|what if|would that|does that|45 minutes?|60 minutes?|90 minutes?|hollow metal|steel door|aluminum door)$/i.test(clean);
  if (!isFollowUp || !history?.length) return question;
  const context = history.slice(-4)
    .map((turn) => `${turn.role === "assistant" ? "TYK" : "User"}: ${turn.content}`)
    .join("\n");
  return `Answer this follow-up in the existing conversation.\n${context}\nLatest user detail/question: ${question}`;
}

function webSourceCitations(sources) {
  return (sources || []).map((source) => ({
    document: source.title,
    url: source.url,
    domain: source.domain,
    sourceType: source.sourceType || (source.authoritative ? "authoritative_web" : "web_search"),
    confidence: source.confidence,
    evidence: source.evidenceText,
    authoritative: source.authoritative,
  }));
}

// Records a genuinely unanswerable question so Teach TYK can prioritize
// closing this exact gap later - AI unavailability never loses the question.
async function saveUnansweredQuestion(question) {
  try {
    await supabaseAdmin.from("learning_entries").insert({ question });

    const clean = question.trim().replace(/[?!.]+$/, "");
    const designation = clean.match(/\b(?:what is|what are|tell me about)\s+([a-z0-9-]+)\b/i)?.[1];
    const searchQueries = designation && /^\d+[a-z0-9-]*$/i.test(designation)
      ? [
        clean,
        `${designation} commercial door hardware`,
        `${designation} exit device`,
        `${designation} door hardware manufacturer`,
        `${designation} installation manual`,
      ]
      : [clean, `${clean} official documentation`, `${clean} manufacturer technical information`];

    await supabaseAdmin.from("research_queue").upsert({
      topic: clean,
      title: `Research: ${clean}`,
      description: "Find authoritative external evidence for a question TYK could not answer from its existing knowledge.",
      type: "RESEARCH",
      priority: 6,
      source_type: "web_search",
      search_queries: [...new Set(searchQueries)].slice(0, 5),
      reason: "A user question remained unresolved after internal knowledge, document, learned-answer, and connected-source checks.",
      status: "queued",
    }, { onConflict: "topic,entity_id", ignoreDuplicates: true });
  } catch (err) {
    console.error("Failed to save unanswered question or research task (ignored):", err);
  }
}

// Knowledge-first vision: vision AI only IDENTIFIES what's in frame - TYK's
// own knowledge system should supply the technical/company-specific answer
// whenever it already has one. Zero extra AI calls: just a deterministic
// name match against whatever the vision answer identified, then a plain
// string merge (never another model call) if something confirmed is found.
async function findCompanyKnowledgeForVisualAnswer(visionAnswer) {
  const candidates = [
    ...new Set(
      (visionAnswer.match(/\b[A-Z][A-Za-z0-9-]{2,}\b/g) || [])
        .map((w) => w.trim())
        .filter((w) => w.length >= 3),
    ),
  ].slice(0, 8);
  if (candidates.length === 0) return null;

  const orFilter = candidates.map((c) => `name.ilike.%${c}%`).join(",");
  const { data: entities } = await supabaseAdmin
    .from("knowledge_entities")
    .select("id, name, entity_type")
    .or(orFilter)
    .limit(3);
  if (!entities?.length) return null;

  const lines = [];
  for (const entity of entities) {
    const { data: facts } = await supabaseAdmin
      .from("knowledge_facts")
      .select("fact_key, fact_value")
      .eq("entity_id", entity.id)
      .eq("status", "confirmed")
      .not("fact_value", "is", null)
      .limit(5);
    if (facts?.length) {
      lines.push(
        `${entity.name} (${entity.entity_type}): ` +
          facts.map((f) => `${f.fact_key.replace(/_/g, " ")} - ${f.fact_value}`).join("; "),
      );
    }
  }
  return lines.length ? lines.join("\n") : null;
}

function buildPrompt(question, knowledgeChunks, attachedDocuments, history, summary, topicSummary) {
  let context = "";

  if (topicSummary) {
    context += "\n\nCONVERSATION TOPIC SUMMARY (compact context):\n" + topicSummary + "\n";
  }

  if (summary) {
    context += "\n\nEARLIER CONVERSATION SUMMARY (older turns already condensed):\n" + summary + "\n";
  }

  if (history?.length > 0) {
    context += "\n\nRECENT CONVERSATION (for context - do not re-answer these):\n";
    for (const turn of history) {
      context += `${turn.role === "assistant" ? "TYK" : "User"}: ${turn.content}\n`;
    }
  }

  if (knowledgeChunks.length > 0) {
    context += "\n\nRELEVANT KNOWLEDGE BASE EXCERPTS:\n";
    for (const chunk of knowledgeChunks) {
      context += `\n[Source: ${chunk.documentName}, Page ${
        chunk.page ?? "?"
      }]\n${chunk.content}\n`;
    }
  }

  if (attachedDocuments.length > 0) {
    context += "\n\nDOCUMENT(S) ATTACHED TO THIS MESSAGE:\n";
    for (const doc of attachedDocuments) {
      context += `\n=== ${doc.documentName} ===\n${doc.fullText}\n`;
    }
  }

  return `You are TYK, an AI assistant for commercial door companies.

Your job is to provide accurate, practical answers about commercial doors, frames, hardware, installation, drawings, specifications, building codes, and related construction topics.

IMPORTANT:
- Answer clearly and directly.
- Do not invent information.
- If you are unsure, say that you are unsure.
- Use the knowledge base excerpts and attached documents below as your primary source when they are relevant; otherwise rely on general knowledge.
- Distinguish between information from the knowledge base/documents and general knowledge when appropriate.
- Do not claim that you checked a document unless one was actually provided to you below.
- If an attached document is a hardware/door schedule and knowledge base excerpts include fire code requirements, check EVERY opening in the schedule against those requirements one by one, and clearly flag any opening that does not comply (explain why) as well as any that do comply.
- If an image is attached, you are seeing it live through a camera - actually look at it and identify the specific product/hardware/object shown (brand, model/series number, and any readable text or labels), then answer the user's question using that identification. Never say you can't see the image if one was provided. If you can't identify it with confidence, say what you can tell and that you're not fully certain, rather than refusing to answer.
- If recent conversation history (and an earlier conversation summary, if provided) is below, use it to understand what "this", "that", or "it" refers to, and keep your answer consistent with what was already discussed.
${context}
User question:
${question}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (req.method !== "POST") {
      return new Response(
        JSON.stringify({ error: "POST requests only" }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const body = await req.json();
    const question = body?.question;
    const conversationId = body?.conversationId || null;
    const attachedDocumentIds = Array.isArray(body?.attachedDocumentIds)
      ? body.attachedDocumentIds
      : [];
    const images = Array.isArray(body?.images) ? body.images : [];
    const history = Array.isArray(body?.history) ? body.history : [];
    const suppressLearning = body?.suppressLearning === true;

    if (!question || typeof question !== "string") {
      return new Response(
        JSON.stringify({ error: "A question is required." }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    const startedAt = Date.now();
    const normalizedQuestion = normalizeQuestion(question);
    const researchQuestion = contextualResearchQuestion(question, history);

    const isPlainTextQuestion = images.length === 0 &&
      attachedDocumentIds.length === 0;

    // Deterministic gate: only worth trying when this is a plain text question
    // (vision and attached-document tasks inherently need AI reasoning).
    if (isPlainTextQuestion) {
      const deterministic = tryCalculation(normalizedQuestion) ||
        await tryDocumentMetaLookup(normalizedQuestion) ||
        await tryDirectFactExtraction(normalizedQuestion);

      if (deterministic) {
        logAiUsage({
          question: normalizedQuestion,
          intent: deterministic.intent,
          source_used: deterministic.sourceUsed,
          ai_required: false,
          latency_ms: Date.now() - startedAt,
        });

        return new Response(
          JSON.stringify({
            success: true,
            answer: deterministic.answer,
            provider: "none",
            model: "none",
            sources: [],
            aiRequired: false,
            needsWebResearch: false,
            researchReason: "A deterministic TYK lookup answered the question.",
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }
    }

    // Embed once and reuse it for both learned-answer reuse and document RAG,
    // instead of embedding the same question twice.
    let questionEmbedding = null;
    try {
      questionEmbedding = await embedText(normalizedQuestion);
    } catch (err) {
      console.error("Embedding failed (continuing without it):", err);
    }

    // Knowledge-first reuse: a semantically similar question we've already
    // answered and verified means zero AI calls this time too.
    if (isPlainTextQuestion && questionEmbedding && !suppressLearning) {
      const reusable = await findReusableAnswer(questionEmbedding);
      if (reusable) {
        markAnswerReused(reusable.id);

        let reusedSources = [];
        if (reusable.source_document_ids?.length) {
          const { data: docs } = await supabaseAdmin
            .from("documents")
            .select("name")
            .in("id", reusable.source_document_ids);
          reusedSources = (docs || []).map((d) => ({ document: d.name }));
        }

        logAiUsage({
          question: normalizedQuestion,
          intent: "reused_answer",
          source_used: "learned_knowledge_reuse",
          ai_required: false,
          latency_ms: Date.now() - startedAt,
        });

        return new Response(
          JSON.stringify({
            success: true,
            answer: reusable.answer,
            provider: "none",
            model: "none",
            sources: reusedSources,
            aiRequired: false,
            needsWebResearch: false,
            researchReason: "A verified learned answer matched the question.",
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }
    }

    const [knowledgeChunks, attachedDocuments] = await Promise.all([
      searchKnowledge(questionEmbedding),
      loadAttachedDocuments(attachedDocumentIds),
    ]);

    // Fire code / connected-source domain check happens before AI - the
    // connected source itself is the authority, not a model's guess.
    if (isPlainTextQuestion) {
      const sourceResult = await tryConnectedSource(normalizedQuestion);
      if (sourceResult) {
        if (questionEmbedding) {
          saveLearnedAnswer({
            question,
            normalizedQuestion,
            intent: "connected_source",
            answer: sourceResult.answer,
            embedding: questionEmbedding,
            sourceDocumentIds: [],
            searchTerms: [],
          });
        }

        logAiUsage({
          question: normalizedQuestion,
          intent: "connected_source",
          source_used: `connected_source:${sourceResult.provider}`,
          ai_required: false,
          latency_ms: Date.now() - startedAt,
        });

        return new Response(
          JSON.stringify({
            success: true,
            answer: sourceResult.answer,
            sources: [{ document: sourceResult.citation }],
            aiRequired: false,
            needsWebResearch: false,
            researchReason: "A connected authoritative source answered the question.",
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    const researchDecision = decideWebResearch(isPlainTextQuestion, knowledgeChunks);

    if (isPlainTextQuestion && researchDecision.needsWebResearch) {
      const savedSource = await findSavedWebSource(researchQuestion);
      if (savedSource && !isBoilerplate(savedSource.answer)) {
        logAiUsage({
          question: normalizedQuestion,
          intent: "saved_web_source",
          source_used: "saved_external_source",
          ai_required: false,
          latency_ms: Date.now() - startedAt,
        });

        return new Response(
          JSON.stringify({
            success: true,
            answer: savedSource.answer,
            sources: [{
              document: savedSource.title || savedSource.domain,
              url: savedSource.url,
              domain: savedSource.domain,
              sourceType: savedSource.source_type,
              confidence: savedSource.confidence,
              authoritative: savedSource.authoritative,
            }],
            aiRequired: false,
            needsWebResearch: false,
            researchReason: "A previously saved external source matched.",
            conversationMeta: {
              title: savedSource.title,
              topicSummary: savedSource.topic,
              source: "saved_web_source",
            },
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (isFireCodeQuestion(normalizedQuestion)) {
        try {
          const officialResearch = await researchKnownAuthoritativeSource(researchQuestion);
          if (officialResearch) {
            await saveWebResearch(officialResearch, conversationId);
            const researchedAnswer = officialResearch.answer;
            logAiUsage({
              question: normalizedQuestion,
              intent: "official_code_research",
              source_used: officialResearch.provider,
              ai_required: false,
              latency_ms: Date.now() - startedAt,
            });

            return new Response(
              JSON.stringify({
                success: true,
                answer: researchedAnswer,
                sources: webSourceCitations(officialResearch.sources),
                aiRequired: false,
                needsWebResearch: true,
                researchReason: "Official Ontario code sources were fetched before any unresolved fallback.",
                conversationMeta: {
                  title: officialResearch.title,
                  topicSummary: officialResearch.topicSummary,
                  source: "official_code_research",
                },
              }),
              {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }
        } catch (err) {
          console.error("Official code research failed (continuing to Google/AI):", err);
        }
      }
    }

    if (researchDecision.needsWebResearch) {
      try {
        const research = await researchWeb(researchQuestion);
        if (research) {
          await saveWebResearch(research, conversationId);
          const researchedAnswer = research.ambiguity
            ? `${research.answer}\n\nEvidence note: ${research.ambiguity}`
            : research.answer;
          if (questionEmbedding && !suppressLearning) {
            await saveLearnedAnswer({
              question,
              normalizedQuestion,
              intent: "web_research",
              answer: researchedAnswer,
              embedding: questionEmbedding,
              sourceDocumentIds: null,
              searchTerms: normalizedQuestion.toLowerCase().split(/\W+/).filter((term) => term.length > 2),
              forceVerified: true,
            });
          }
          logAiUsage({
            question: normalizedQuestion,
            intent: "web_research",
            source_used: research.provider,
            ai_required: true,
            provider: research.provider,
            model: research.model,
            output_tokens_estimate: estimateTokens(research.answer),
            latency_ms: Date.now() - startedAt,
          });

          return new Response(
            JSON.stringify({
              success: true,
              answer: researchedAnswer,
              sources: webSourceCitations(research.sources).map((source) => ({
                ...source,
                confidence: research.confidence,
                evidence: source.evidenceText,
                authoritative: source.authoritative,
              })),
              aiRequired: true,
              needsWebResearch: true,
              researchReason: researchDecision.reason,
              conversationMeta: {
                title: research.title,
                topicSummary: research.topicSummary,
                source: "web_research",
              },
            }),
            {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
      } catch (err) {
        console.error("Web research failed (falling through to AI):", err);
      }
    }

    // Older turns beyond the last few (already sent verbatim in `history`)
    // are folded into a running summary by conversation-store as the chat
    // grows, so long conversations keep real continuity without the raw
    // history sent to AI ever growing unbounded.
    let conversationSummary = null;
    let conversationTopicSummary = null;
    if (conversationId) {
      try {
        const { data } = await supabaseAdmin
          .from("conversations")
          .select("summary, topic_summary")
          .eq("id", conversationId)
          .maybeSingle();
        conversationSummary = data?.summary || null;
        conversationTopicSummary = data?.topic_summary || null;
      } catch (err) {
        console.error("Failed to load conversation summary (ignored):", err);
      }
    }

    const prompt = buildPrompt(
      normalizedQuestion,
      knowledgeChunks,
      attachedDocuments,
      history,
      conversationSummary,
      conversationTopicSummary,
    );

    let answer, provider, model, failedProviders;
    try {
      ({ answer, provider, model, failedProviders } = await generateAnswer(
        prompt,
        images,
      ));
    } catch (aiError) {
      // Full detail is only ever logged server-side (provider_health table +
      // console) - the user must never see provider names, error codes, or
      // quota/billing text.
      console.error("AI generation failed:", aiError);

      logAiUsage({
        question: normalizedQuestion,
        intent: images.length > 0 ? "vision" : "general_question",
        source_used: "ai_reasoning_failed",
        ai_required: true,
        input_tokens_estimate: estimateTokens(prompt),
        latency_ms: Date.now() - startedAt,
      });

      const partial = isPlainTextQuestion
        ? buildPartialAnswer(knowledgeChunks)
        : null;

      if (!partial && isPlainTextQuestion && !suppressLearning) {
        await saveUnansweredQuestion(normalizedQuestion);
      }

      const fallbackAnswer = partial || (suppressLearning
        ? "I don't have enough verified information to answer that yet."
        : "I couldn't find a reliable source yet. I've created a research task so TYK can investigate it further.");

      return new Response(
        JSON.stringify({
          success: true,
          answer: fallbackAnswer,
          provider: "none",
          model: "none",
          sources: partial
            ? knowledgeChunks.slice(0, 2).map((c) => ({
              document: c.documentName,
              page: c.page,
            }))
            : [],
          aiRequired: true,
            needsWebResearch: researchDecision.needsWebResearch,
            researchReason: researchDecision.reason,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (failedProviders.length > 0) {
      console.warn(
        `TYK fell back to "${provider}" after failures: ${failedProviders.join(", ")}`,
      );
    }

    // Knowledge-first vision: the model above only IDENTIFIES what's on
    // camera - if that identification matches something TYK already has
    // company-confirmed facts about, merge those in deterministically
    // (zero extra AI calls) rather than letting the vision guess stand
    // alone as the final answer.
    let finalAnswer = answer;
    if (images.length > 0) {
      try {
        const companyKnowledge = await findCompanyKnowledgeForVisualAnswer(answer);
        if (companyKnowledge) {
          finalAnswer = `${answer}\n\nCompany knowledge:\n${companyKnowledge}`;
        }
      } catch (err) {
        console.error("Visual knowledge merge failed (ignored):", err);
      }
    }

    const sources = knowledgeChunks.map((chunk) => ({
      document: chunk.documentName,
      page: chunk.page,
      similarity: chunk.similarity,
    }));

    // Store this AI answer for future reuse. It's only trustworthy enough to
    // auto-reuse later if it was grounded in real retrieved sources; otherwise
    // it's saved as an unverified hypothesis (never auto-served as fact).
    if (isPlainTextQuestion && questionEmbedding) {
      const sourceDocumentIds = [
        ...new Set(knowledgeChunks.map((c) => c.documentId)),
      ];
      const searchTerms = normalizedQuestion
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 3);

      saveLearnedAnswer({
        question,
        normalizedQuestion,
        intent: "general_question",
        answer,
        embedding: questionEmbedding,
        sourceDocumentIds,
        searchTerms,
      });
    }

    logAiUsage({
      question: normalizedQuestion,
      intent: images.length > 0
        ? "vision"
        : attachedDocumentIds.length > 0
        ? "document_analysis"
        : "general_question",
      source_used: images.length > 0
        ? "vision_model"
        : attachedDocumentIds.length > 0
        ? "attached_documents+ai_reasoning"
        : "vector_search+ai_reasoning",
      ai_required: true,
      provider,
      model,
      input_tokens_estimate: estimateTokens(prompt),
      output_tokens_estimate: estimateTokens(finalAnswer),
      latency_ms: Date.now() - startedAt,
    });

    return new Response(
      JSON.stringify({
        success: true,
        answer: finalAnswer,
        sources,
        aiRequired: true,
        needsWebResearch: researchDecision.needsWebResearch,
        researchReason: researchDecision.reason,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("TYK error:", error);

    return new Response(
      JSON.stringify({
        success: true,
        answer:
          "Something went wrong on my end. Please try asking again in a moment.",
        sources: [],
        aiRequired: false,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});