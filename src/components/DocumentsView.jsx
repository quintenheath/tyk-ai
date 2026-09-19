import { useEffect, useRef, useState } from "react";
import { supabase } from "../utils/supabase";
import {
  deleteDocument,
  downloadAllDocuments,
  downloadDocument,
  exportEverything,
  exportTykKnowledge,
  listDocuments,
  uploadDocument,
  verifyDocument,
} from "../utils/documents";

const STATUS_LABELS = {
  uploading: "Uploading…",
  processing: "Processing…",
  indexed: "Indexed",
  error: "Error",
};

function statusClass(status) {
  if (status === "indexed") return "doc-status doc-status-ok";
  if (status === "error") return "doc-status doc-status-error";
  return "doc-status doc-status-pending";
}

function DocumentsView({ identity }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [errorText, setErrorText] = useState("");
  const fileInputRef = useRef(null);
  const canUpload = identity?.permissions?.can_upload_documents;
  const canManage = identity?.permissions?.can_manage_documents;

  useEffect(() => {
    refresh();
    // Poll while anything is still processing so status updates without a manual reload.
    const interval = setInterval(() => {
      setDocuments((current) => {
        const hasPending = current.some(
          (d) => d.status === "uploading" || d.status === "processing",
        );
        if (hasPending) refresh();
        return current;
      });
    }, 4000);

    // Live shared knowledge: any authorized user's upload (or an admin's
    // delete) shows up here immediately for every other connected client -
    // no refresh/reinstall needed, the DB is the single source of truth.
    const channel = supabase
      .channel("documents-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "documents" },
        () => refresh(),
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, []);

  async function refresh() {
    try {
      setDocuments(await listDocuments());
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setUploading(true);
    setErrorText("");
    try {
      const document = await uploadDocument(file, identity);
      setDocuments((prev) => [document, ...prev]);
      setTimeout(refresh, 2000);
    } catch (err) {
      console.error("Upload failed:", err);
      setErrorText("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(documentId) {
    setDocuments((prev) => prev.filter((d) => d.id !== documentId));
    try {
      await deleteDocument(documentId, identity);
    } catch (err) {
      console.error("Delete failed:", err);
      refresh();
    }
  }

  async function startDownload(action, key) {
    setExporting(key);
    setErrorText("");
    try {
      const { url } = await action(identity);
      const link = document.createElement("a");
      link.href = url;
      link.click();
    } catch (err) {
      console.error("Download/export failed:", err);
      setErrorText("Download failed. Please try again.");
    } finally {
      setExporting("");
    }
  }

  async function handleVerify(documentId) {
    setExporting(`verify-${documentId}`);
    try {
      await verifyDocument(documentId, identity);
      await refresh();
    } catch (err) {
      console.error("Verification failed:", err);
      setErrorText("Document verification failed.");
    } finally {
      setExporting("");
    }
  }

  return (
    <main className="documents-main">
      <div className="documents-header">
        <h1>Documents</h1>
        <p>
          Upload a PDF and TYK will automatically figure out the
          manufacturer, product, and document type - no need to classify it
          yourself.
        </p>
      </div>

      <div className="documents-upload">
        <button
          type="button"
          className="upload-button"
          disabled={uploading || !canUpload}
          onClick={() => fileInputRef.current?.click()}
          title={canUpload ? undefined : "You don't have permission to upload documents"}
        >
          {uploading ? "Uploading…" : "Upload PDF"}
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf,.pdf,text/plain,.txt"
          hidden
          onChange={handleFileChange}
        />
        <button type="button" className="teach-skip-button" disabled={exporting !== "" || !canUpload} onClick={() => startDownload(downloadAllDocuments, "all")}>
          {exporting === "all" ? "Preparing…" : "Download All Documents"}
        </button>
        <button type="button" className="teach-skip-button" disabled={exporting !== "" || identity?.role !== "admin"} onClick={() => startDownload(exportTykKnowledge, "knowledge")}>
          {exporting === "knowledge" ? "Preparing…" : "Export TYK Knowledge"}
        </button>
        <button type="button" className="teach-skip-button" disabled={exporting !== "" || identity?.role !== "admin"} onClick={() => startDownload(exportEverything, "everything")}>
          {exporting === "everything" ? "Preparing…" : "Export Everything"}
        </button>
      </div>

      {errorText && <div className="inline-error">{errorText}</div>}

      <div className="documents-list">
        {loading && <div className="documents-empty">Loading…</div>}

        {!loading && documents.length === 0 && (
          <div className="documents-empty">
            No documents yet. Upload a PDF to get started.
          </div>
        )}

        {documents.map((doc) => (
          <div className="document-row" key={doc.id}>
            <div className="document-row-main">
              <div className="document-name">{doc.name}</div>
              <div className="document-meta">
                {doc.manufacturer && (
                  <span className="document-tag">{doc.manufacturer}</span>
                )}
                {doc.document_type && (
                  <span className="document-tag">{doc.document_type}</span>
                )}
                {doc.product && (
                  <span className="document-tag">{doc.product}</span>
                )}
                {doc.chunk_count > 0 && (
                  <span>{doc.chunk_count} chunks indexed</span>
                )}
                {doc.verification_status && (
                  <span className="document-tag">{doc.verification_status}</span>
                )}
              </div>
              {doc.topics?.length > 0 && (
                <div className="document-topics">
                  {doc.topics.slice(0, 6).map((topic) => (
                    <span className="document-topic-pill" key={topic}>
                      {topic}
                    </span>
                  ))}
                </div>
              )}
              {doc.status === "error" && doc.error_message && (
                <div className="document-error">{doc.error_message}</div>
              )}
            </div>

            <div className={statusClass(doc.status)}>
              {STATUS_LABELS[doc.status] || doc.status}
            </div>

            <button
              type="button"
              className="teach-skip-button"
              disabled={exporting !== "" || !canUpload || !doc.has_file}
              title={doc.has_file ? "Download original file" : "No original file is stored for this source record"}
              onClick={() => startDownload((currentIdentity) => downloadDocument(doc.id, currentIdentity), doc.id)}
            >
              {exporting === doc.id ? "…" : doc.has_file ? "Download" : "No file stored"}
            </button>
            {doc.source_url && (
              <button type="button" className="teach-skip-button" disabled={exporting !== ""} onClick={() => handleVerify(doc.id)}>
                {exporting === `verify-${doc.id}` ? "Checking…" : "Verify now"}
              </button>
            )}

            <button
              type="button"
              className="document-delete"
              title="Delete document"
              onClick={() => handleDelete(doc.id)}
              hidden={!canManage}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}

export default DocumentsView;
