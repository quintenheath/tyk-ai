import { supabase } from "./supabase";

// Recent turns give TYK context so voice/vision/chat all continue the same
// conversation instead of answering each question in isolation.
export function toHistory(messages, limit = 8) {
  return messages
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}

// ask-tyk always returns a clean 200 response, even when every AI provider
// fails - so an `error` here means a genuine connectivity/infra problem, not
// an AI provider issue. Never surface raw error details to the user.
export async function askTyk({
  question,
  attachedDocumentIds,
  images,
  history,
  conversationId,
}) {
  const { data, error } = await supabase.functions.invoke("ask-tyk", {
    body: { question, attachedDocumentIds, images, history, conversationId },
  });

  if (error) {
    console.error("TYK request failed:", error);
    return {
      answer: "I couldn't reach TYK just now. Please try again in a moment.",
    };
  }

  return {
    answer: data?.answer || data?.message || "TYK couldn't generate an answer.",
    sources: data?.sources || [],
  };
}
