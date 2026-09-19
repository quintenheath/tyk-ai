import { supabase } from "./supabase";

// All conversation/message access is routed through the conversation-store
// Edge Function (service role), since RLS filters out anon reads and writes.

async function invokeConversationStore(payload) {
  const { data, error } = await supabase.functions.invoke(
    "conversation-store",
    { body: payload },
  );

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listConversations(identity) {
  const { conversations } = await invokeConversationStore({
    action: "list",
    token: identity?.token,
  });
  return conversations || [];
}

export async function loadConversationMessages(conversationId, identity) {
  const { messages } = await invokeConversationStore({
    action: "get",
    conversation_id: conversationId,
    token: identity?.token,
  });
  return messages || [];
}

export function createConversation(firstMessage, identity) {
  return invokeConversationStore({
    action: "create",
    firstMessage,
    token: identity?.token,
  });
}

export function appendMessage(conversationId, message, identity) {
  return invokeConversationStore({
    action: "append",
    conversation_id: conversationId,
    message,
    token: identity?.token,
  });
}

export function renameConversation(conversationId, title, identity) {
  return invokeConversationStore({
    action: "rename",
    conversation_id: conversationId,
    title,
    token: identity?.token,
  });
}

export function deleteConversation(conversationId, identity) {
  return invokeConversationStore({
    action: "delete",
    conversation_id: conversationId,
    token: identity?.token,
  });
}

export async function listDeletedConversations(filters, identity) {
  return invokeConversationStore({ action: "list-deleted", ...filters, token: identity?.token });
}

export async function loadDeletedConversation(conversationId, identity) {
  return invokeConversationStore({ action: "get-deleted", conversation_id: conversationId, token: identity?.token });
}

export async function restoreConversation(conversationId, identity) {
  return invokeConversationStore({ action: "restore", conversation_id: conversationId, token: identity?.token });
}

// Explicit human confirmation that a piece of conversation content (often
// from a temporary Installer/Other session) should become permanent company
// knowledge, reusing the same learned_answers cache the main chat checks.
// Only callers with can_approve_company_knowledge get it live immediately;
// everyone else's suggestion is saved as pending until an approver reviews it.
export function promoteToCompanyKnowledge(question, answer, identity) {
  return invokeConversationStore({
    action: "promote-to-company-knowledge",
    question,
    answer,
    token: identity?.token,
  });
}

export async function listPendingPromotions(identity) {
  const { pending } = await invokeConversationStore({
    action: "list-pending-promotions",
    token: identity?.token,
  });
  return pending || [];
}

export function approvePromotion(identity, learnedAnswerId, approve) {
  return invokeConversationStore({
    action: "approve-promotion",
    token: identity?.token,
    learned_answer_id: learnedAnswerId,
    approve,
  });
}

// Groups conversations into ChatGPT-style buckets for the history list.
export function groupConversationsByRecency(conversations) {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - 7);

  const groups = {
    Today: [],
    Yesterday: [],
    "Previous 7 Days": [],
    Older: [],
  };

  for (const conversation of conversations) {
    const updatedAt = new Date(conversation.updated_at);
    if (updatedAt >= startOfToday) {
      groups.Today.push(conversation);
    } else if (updatedAt >= startOfYesterday) {
      groups.Yesterday.push(conversation);
    } else if (updatedAt >= startOfWeek) {
      groups["Previous 7 Days"].push(conversation);
    } else {
      groups.Older.push(conversation);
    }
  }

  return Object.entries(groups).filter(([, items]) => items.length > 0);
}
