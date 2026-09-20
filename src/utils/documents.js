import { supabase } from "./supabase";

// All document access goes through document-manager (service role), since
// RLS is enabled with zero policies on documents/document_chunks. Uploads and
// deletes are permission-gated server-side (can_upload_documents/
// can_manage_documents), verified from a signed session token - never a bare
// id, which anyone who obtained/guessed it could otherwise use to impersonate
// that identity.
function ownerParams(identity) {
  return { token: identity?.token };
}

async function invokeDocumentManager(payload) {
  const { data, error } = await supabase.functions.invoke(
    "document-manager",
    { body: payload },
  );

  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listDocuments({ page = 1, pageSize = 50, search = "" } = {}) {
  return invokeDocumentManager({ action: "list", page, page_size: pageSize, search });
}

export async function deleteDocument(documentId, identity) {
  return invokeDocumentManager({
    action: "delete",
    document_id: documentId,
    ...ownerParams(identity),
  });
}

export async function downloadDocument(documentId, identity) {
  return invokeDocumentManager({
    action: "download",
    document_id: documentId,
    ...ownerParams(identity),
  });
}

export async function downloadAllDocuments(identity) {
  return invokeDocumentManager({ action: "download-all", ...ownerParams(identity) });
}

export async function exportTykKnowledge(identity) {
  return invokeDocumentManager({ action: "export-knowledge", ...ownerParams(identity) });
}

export async function exportEverything(identity) {
  return invokeDocumentManager({ action: "export-everything", ...ownerParams(identity) });
}

export async function verifyDocument(documentId, identity) {
  return invokeDocumentManager({ action: "verify", document_id: documentId, ...ownerParams(identity) });
}

export async function listDocumentVersions(documentId, identity) {
  return invokeDocumentManager({ action: "versions", document_id: documentId, ...ownerParams(identity) });
}

// Uploads a file directly to storage via a signed URL, then triggers
// server-side processing (extract -> chunk -> embed -> auto-classify).
// TYK determines manufacturer/product/document type itself; the user never
// has to categorize anything.
export async function uploadDocument(file, identity, { description, documentScope, auditId, conversationId } = {}) {
  const { document, uploadUrl } = await invokeDocumentManager({
    action: "request-upload",
    name: file.name,
    fileType: file.type,
    fileSize: file.size,
    description: description || null,
    document_scope: documentScope || "COMPANY",
    audit_id: auditId || null,
    conversation_id: conversationId || null,
    ...ownerParams(identity),
  });

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });

  if (!uploadResponse.ok) {
    throw new Error("Failed to upload file to storage.");
  }

  // Processing runs after upload completes; failures are reflected in status.
  invokeDocumentManager({
    action: "process",
    document_id: document.id,
    ...ownerParams(identity),
  }).catch((err) => console.error("Document processing failed:", err));

  return document;
}

export async function generateConversationalFile({ format, title, content }, identity) {
  const { data, error } = await supabase.functions.invoke("document-generator", {
    body: { format, title, content, token: identity?.token },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

