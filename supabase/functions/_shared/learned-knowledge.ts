// Reusable "learned knowledge" cache: verified answers are checked BEFORE
// ever calling AI again for a semantically similar question. Unverified
// (AI-hypothesis) answers are stored for the record but never auto-reused,
// per the "do not treat AI claims as authoritative" requirement.
import { supabaseAdmin } from "./supabase-admin.ts";

const SIMILARITY_THRESHOLD = 0.86;

export async function findReusableAnswer(embedding) {
  const { data, error } = await supabaseAdmin.rpc("match_learned_answers", {
    query_embedding: embedding,
    match_count: 1,
    min_status: ["verified", "approved"],
  });

  if (error) {
    console.error("Learned-knowledge search failed (continuing):", error);
    return null;
  }

  const best = data?.[0];
  if (!best || best.similarity < SIMILARITY_THRESHOLD) return null;
  return best;
}

export async function markAnswerReused(id) {
  try {
    const { data } = await supabaseAdmin
      .from("learned_answers")
      .select("reuse_count")
      .eq("id", id)
      .maybeSingle();

    await supabaseAdmin
      .from("learned_answers")
      .update({
        reuse_count: (data?.reuse_count || 0) + 1,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch (err) {
    console.error("Failed to update reuse count (ignored):", err);
  }
}

// Grounded (backed by retrieved document chunks) answers are trustworthy
// enough to reuse later. Answers with no supporting source are only a
// hypothesis until a human/Teach TYK approves them. forceVerified lets an
// explicit human confirmation (e.g. "save to company knowledge") skip that
// without needing a source_document_ids entry (which must be real uuids).
export async function saveLearnedAnswer({
  question,
  normalizedQuestion,
  intent,
  answer,
  embedding,
  sourceDocumentIds,
  searchTerms,
  forceVerified,
}) {
  try {
    await supabaseAdmin.from("learned_answers").insert({
      question,
      normalized_question: normalizedQuestion,
      intent,
      answer,
      status: forceVerified || sourceDocumentIds?.length > 0 ? "verified" : "hypothesis",
      embedding,
      source_document_ids: sourceDocumentIds?.length ? sourceDocumentIds : null,
      search_terms: searchTerms?.length ? searchTerms : null,
    });
  } catch (err) {
    console.error("Failed to save learned answer (ignored):", err);
  }
}
