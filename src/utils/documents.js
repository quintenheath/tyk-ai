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

export async function listDocuments() {
  const { documents } = await invokeDocumentManager({ action: "list" });
  return documents || [];
}

export async function deleteDocument(documentId, identity) {
  return invokeDocumentManager({
    action: "delete",
    document_id: documentId,
    ...ownerParams(identity),
  });
}

// Uploads a file directly to storage via a signed URL, then triggers
// server-side processing (extract -> chunk -> embed -> auto-classify).
// TYK determines manufacturer/product/document type itself; the user never
// has to categorize anything.
export async function uploadDocument(file, identity, { description } = {}) {
  const { document, uploadUrl } = await invokeDocumentManager({
    action: "request-upload",
    name: file.name,
    fileType: file.type,
    fileSize: file.size,
    description: description || null,
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

