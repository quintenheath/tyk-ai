// Server-side conversation/message persistence.
// Runs with the service role so it can bypass RLS; the anon/browser client
// has no direct read/write access (RLS is enabled with zero policies).
//
// Every conversation belongs to EXACTLY ONE owner: a persistent app_users.id
// (Admin/Office - permanent history) or a temp_sessions.id (Installer/Other -
// deleted entirely on sign-out via end-temp-session in auth-users). The owner
// is derived from a SIGNED session token (see _shared/session.ts), never a
// bare id sent by the client - otherwise a guessed/obtained user_id could be
// used to read or write someone else's conversations.
import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { embedText } from "../_shared/embeddings.ts";
import { saveLearnedAnswer } from "../_shared/learned-knowledge.ts";
import { hasPermission, loadIdentity } from "../_shared/permissions.ts";
import { generateAnswer } from "../_shared/ai-router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function titleFromMessage(content) {
  const clean = content
    .trim()
    .replace(/^(what is|what are|who is|where is|how does|how do|can you explain)\s+/i, "")
    .replace(/[?.!]+$/, "")
    .replace(/\s+/g, " ");
  const title = clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "New conversation";
  if (title.length <= 56) return title;
  const truncated = title.slice(0, 56);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "…";
}

function topicSummaryFromMessage(content) {
  const clean = content.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "");
  return clean ? `Discussion about ${clean}.` : null;
}

function isPlaceholderTitle(title) {
  return !title || /^(what|how|can|does|is|why|where|who)\b/i.test(title);
}

async function maybeUpdateConversationMetadata(conversationId, metadata) {
  const suggestion = metadata?.conversationMeta;
  if (!suggestion?.title && !suggestion?.topicSummary) return;

  const { data: current } = await supabase
    .from("conversations")
    .select("title, topic_summary")
    .eq("id", conversationId)
    .maybeSingle();
  if (!current) return;

  const isResearch = suggestion.source === "web_research" ||
    suggestion.source === "saved_web_source";
  if (!isResearch && !isPlaceholderTitle(current.title)) {
    return;
  }

  await supabase
    .from("conversations")
    .update({
      ...(suggestion.title ? { title: suggestion.title.trim() } : {}),
      ...(suggestion.topicSummary
        ? { topic_summary: suggestion.topicSummary.trim() }
        : {}),
    })
    .eq("id", conversationId);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function loadQuintenIdentity(body) {
  const identity = await loadIdentity(body);
  const authorizedId = Deno.env.get("QUINTEN_USER_ID");
  return identity?.type === "user" && authorizedId && identity.id === authorizedId
    ? identity
    : null;
}

// Every ~20 new messages, compact everything older than the last 8 turns
// (the window ask-tyk already sends verbatim) into a short running summary,
// so a long-running conversation keeps real continuity without the raw
// history sent to AI ever growing unbounded. Fire-and-forget: a summary
// failure must never break the actual chat turn that triggered it.
const SUMMARY_BATCH_SIZE = 20;
const RECENT_WINDOW = 8;

async function maybeSummarizeConversation(conversationId) {
  try {
    const { data: conversation } = await supabase
      .from("conversations")
      .select("summary, summary_covered_count")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conversation) return;

    const { count: totalCount } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId);

    const covered = conversation.summary_covered_count || 0;
    const summarizableCount = (totalCount || 0) - RECENT_WINDOW;
    if (summarizableCount - covered < SUMMARY_BATCH_SIZE) return;

    const { data: newMessages } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .range(covered, summarizableCount - 1);
    if (!newMessages?.length) return;

    const transcript = newMessages
      .map((m) => `${m.role === "assistant" ? "TYK" : "User"}: ${m.content}`)
      .join("\n");

    const prompt = `Update the running summary of this ongoing conversation between a commercial door company employee and TYK, their AI assistant.

Existing summary so far:
${conversation.summary || "(none yet)"}

New messages to fold in:
${transcript}

Write an updated summary (a few short sentences) capturing the important facts, decisions, and context established so far - not a transcript. Respond with ONLY the updated summary text.`;

    const { answer } = await generateAnswer(prompt);

    await supabase
      .from("conversations")
      .update({ summary: answer.trim(), summary_covered_count: summarizableCount })
      .eq("id", conversationId);
  } catch (err) {
    console.error("Conversation summarization failed (ignored):", err);
  }
}

// Every action that touches a conversation must be scoped to exactly one
// owner column, derived from the verified token - so persistent and
// temporary users never see (or overwrite) each other's conversations.
async function ownerColumn(body) {
  const identity = await loadIdentity(body);
  if (!identity) return null;
  return identity.type === "user"
    ? { column: "user_id", value: identity.id }
    : { column: "session_id", value: identity.id };
}

// Confirms the verified caller actually owns this specific conversation -
// a conversation_id alone (e.g. copy-pasted, guessed, or leaked) must never
// be enough to read/rename/delete/append to someone else's conversation.
async function ownsConversation(body, conversationId) {
  const owner = await ownerColumn(body);
  if (!owner) return false;
  const { data } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq(owner.column, owner.value)
    .is("deleted_at", null)
    .maybeSingle();
  return Boolean(data);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "list") {
      const owner = await ownerColumn(body);
      if (!owner) return json({ error: "A valid session token is required" }, 401);

      const { data, error } = await supabase
        .from("conversations")
        .select("id, title, topic_summary, created_at, updated_at")
        .eq(owner.column, owner.value)
        .is("deleted_at", null)
        .order("updated_at", { ascending: false });

      if (error) return json({ error: error.message }, 500);
      return json({ conversations: data || [] });
    }

    // Deterministic title search scoped to the caller's own conversations
    // (personal scope, so no cross-user leakage even for search results).
    if (action === "search") {
      const owner = await ownerColumn(body);
      if (!owner) return json({ error: "A valid session token is required" }, 401);
      const query = (body.query || "").trim();
      if (!query) return json({ conversations: [] });

      const { data, error } = await supabase
        .from("conversations")
        .select("id, title, topic_summary, updated_at")
        .eq(owner.column, owner.value)
        .is("deleted_at", null)
        .ilike("title", `%${query}%`)
        .order("updated_at", { ascending: false })
        .limit(15);

      if (error) return json({ error: error.message }, 500);
      return json({ conversations: data || [] });
    }

    if (action === "get") {
      const { conversation_id } = body;
      if (!conversation_id) {
        return json({ error: "conversation_id is required" }, 400);
      }
      if (!(await ownsConversation(body, conversation_id))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { data, error } = await supabase
        .from("messages")
        .select("id, role, content, metadata, created_at")
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: true });

      if (error) return json({ error: error.message }, 500);
      return json({ messages: data || [] });
    }

    if (action === "list-deleted") {
      if (!await loadQuintenIdentity(body)) return json({ error: "Forbidden" }, 403);
      let query = supabase
        .from("conversations")
        .select("id, title, topic_summary, user_id, session_id, created_at, updated_at, deleted_at, deleted_by, deletion_reason")
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false });
      if (body.target_user_id) query = query.eq("user_id", body.target_user_id);
      if (body.topic) query = query.or(`title.ilike.%${body.topic}%,topic_summary.ilike.%${body.topic}%`);
      if (body.from) query = query.gte("deleted_at", body.from);
      if (body.to) query = query.lte("deleted_at", body.to);
      const { data, error } = await query;
      if (error) return json({ error: "Could not load deleted conversations." }, 500);
      const userIds = [...new Set((data || []).flatMap((conversation) => [conversation.user_id, conversation.deleted_by]).filter(Boolean))];
      const { data: users } = userIds.length
        ? await supabase.from("app_users").select("id, name, role").in("id", userIds)
        : { data: [] };
      const userById = Object.fromEntries((users || []).map((user) => [user.id, user]));
      const { data: allUsers } = await supabase.from("app_users").select("id, name, role").order("name", { ascending: true });
      return json({ conversations: (data || []).map((conversation) => ({ ...conversation, owner: userById[conversation.user_id] || { role: "temporary" }, deleted_by_name: userById[conversation.deleted_by]?.name || (conversation.deleted_by ? "Authorized account" : "Unknown") })), users: allUsers || [] });
    }

    if (action === "get-deleted") {
      if (!await loadQuintenIdentity(body)) return json({ error: "Forbidden" }, 403);
      const { data: conversation, error } = await supabase.from("conversations").select("*").eq("id", body.conversation_id).not("deleted_at", "is", null).maybeSingle();
      if (error || !conversation) return json({ error: "Deleted conversation not found" }, 404);
      const { data: messages, error: messageError } = await supabase.from("messages").select("id, role, content, metadata, created_at").eq("conversation_id", body.conversation_id).order("created_at", { ascending: true });
      if (messageError) return json({ error: "Could not load deleted conversation." }, 500);
      return json({ conversation, messages: messages || [] });
    }

    if (action === "restore") {
      const identity = await loadQuintenIdentity(body);
      if (!identity) return json({ error: "Forbidden" }, 403);
      const { data, error } = await supabase.from("conversations").update({ deleted_at: null, restored_at: new Date().toISOString(), restored_by: identity.id }).eq("id", body.conversation_id).not("deleted_at", "is", null).select("id, title, topic_summary, created_at, updated_at").maybeSingle();
      if (error || !data) return json({ error: "Deleted conversation not found" }, 404);
      return json({ conversation: data });
    }

    if (action === "create") {
      const { firstMessage } = body;
      const owner = await ownerColumn(body);
      if (!owner) return json({ error: "A valid session token is required" }, 401);
      if (!firstMessage?.content?.trim()) {
        return json({ error: "firstMessage.content is required" }, 400);
      }

      const { data: conversation, error: convError } = await supabase
        .from("conversations")
        .insert({
          title: titleFromMessage(firstMessage.content),
          topic_summary: topicSummaryFromMessage(firstMessage.content),
          [owner.column]: owner.value,
        })
        .select()
        .single();

      if (convError) return json({ error: convError.message }, 500);

      const { data: message, error: msgError } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversation.id,
          role: firstMessage.role || "user",
          content: firstMessage.content,
          metadata: firstMessage.metadata || null,
        })
        .select()
        .single();

      if (msgError) return json({ error: msgError.message }, 500);

      return json({ conversation, message });
    }

    if (action === "append") {
      const { conversation_id, message } = body;
      if (!conversation_id || !message?.content?.trim()) {
        return json(
          { error: "conversation_id and message.content are required" },
          400,
        );
      }
      if (!(await ownsConversation(body, conversation_id))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { data: inserted, error: msgError } = await supabase
        .from("messages")
        .insert({
          conversation_id,
          role: message.role || "user",
          content: message.content,
          metadata: message.metadata || null,
        })
        .select()
        .single();

      if (msgError) return json({ error: msgError.message }, 500);

      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversation_id);

      // Not awaited so it never adds latency to a normal chat turn, but
      // still needs EdgeRuntime.waitUntil - without it, the isolate can be
      // torn down the instant the response is sent, before a bare
      // fire-and-forget promise ever gets to run.
      const summarizePromise = maybeSummarizeConversation(conversation_id);
      if (typeof EdgeRuntime !== "undefined") {
        EdgeRuntime.waitUntil(summarizePromise);
      }
      await maybeUpdateConversationMetadata(conversation_id, message.metadata);

      return json({ message: inserted });
    }

    if (action === "rename") {
      const { conversation_id, title } = body;
      if (!conversation_id || !title?.trim()) {
        return json(
          { error: "conversation_id and title are required" },
          400,
        );
      }
      if (!(await ownsConversation(body, conversation_id))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { data, error } = await supabase
        .from("conversations")
        .update({ title: title.trim() })
        .eq("id", conversation_id)
        .select()
        .single();

      if (error) return json({ error: error.message }, 500);
      return json({ conversation: data });
    }

    if (action === "delete") {
      const { conversation_id } = body;
      if (!conversation_id) {
        return json({ error: "conversation_id is required" }, 400);
      }
      if (!(await ownsConversation(body, conversation_id))) {
        return json({ error: "Forbidden" }, 403);
      }

      const identity = await loadIdentity(body);
      const { error } = await supabase
        .from("conversations")
        .update({ deleted_at: new Date().toISOString(), deleted_by: identity?.id || null, deletion_reason: body.reason || "User deleted conversation" })
        .eq("id", conversation_id);

      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Explicit human confirmation that a piece of (often temporary-user)
    // conversation content should become permanent COMPANY knowledge. Reuses
    // the SAME learned_answers cache the main chat already checks before
    // calling AI - never a second knowledge system. The temporary user's
    // identity is never attached to the saved knowledge. Anyone can SUGGEST a
    // promotion, but it only becomes immediately reusable (status='verified')
    // if the caller actually has can_approve_company_knowledge; otherwise it's
    // saved as an unreviewed 'hypothesis' - visible to approvers, never
    // auto-reused - until someone with that permission approves it.
    if (action === "promote-to-company-knowledge") {
      const { question, answer } = body;
      if (!question?.trim() || !answer?.trim()) {
        return json({ error: "question and answer are required" }, 400);
      }

      const canApprove = await hasPermission(body, "can_approve_company_knowledge");

      let embedding = null;
      try {
        embedding = await embedText(question);
      } catch (err) {
        console.error("Embedding failed while promoting knowledge:", err);
      }

      await saveLearnedAnswer({
        question,
        normalizedQuestion: question.trim().replace(/\s+/g, " "),
        intent: "promoted_company_knowledge",
        answer,
        embedding,
        // Not backed by a retrieved document, but a human explicitly
        // confirmed it - saveLearnedAnswer would otherwise mark anything
        // with no source_document_ids as an unreviewed 'hypothesis'.
        sourceDocumentIds: null,
        searchTerms: null,
        forceVerified: canApprove,
      });

      return json({ ok: true, pendingApproval: !canApprove });
    }

    // Admin/Office (can_approve_company_knowledge) review queue for knowledge
    // suggested by someone without approval authority (e.g. a temp Installer).
    if (action === "list-pending-promotions") {
      if (!(await hasPermission(body, "can_approve_company_knowledge"))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { data, error } = await supabase
        .from("learned_answers")
        .select("id, question, answer, created_at")
        .eq("intent", "promoted_company_knowledge")
        .eq("status", "hypothesis")
        .order("created_at", { ascending: false });

      if (error) return json({ error: error.message }, 500);
      return json({ pending: data || [] });
    }

    if (action === "approve-promotion") {
      if (!(await hasPermission(body, "can_approve_company_knowledge"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { learned_answer_id, approve } = body;
      if (!learned_answer_id) {
        return json({ error: "learned_answer_id is required" }, 400);
      }

      if (approve === false) {
        await supabase.from("learned_answers").delete().eq("id", learned_answer_id);
        return json({ ok: true, rejected: true });
      }

      const { error } = await supabase
        .from("learned_answers")
        .update({ status: "verified" })
        .eq("id", learned_answer_id);

      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});

