import { useEffect, useState } from "react";
import { supabase } from "../utils/supabase";
import { listDocuments, uploadDocument } from "../utils/documents";

async function invokeAudit(payload) {
  const { data, error } = await supabase.functions.invoke("hardware-audit", { body: payload });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

function HardwareAuditView({ identity }) {
  const [documents, setDocuments] = useState([]);
  const [audits, setAudits] = useState([]);
  const [selected, setSelected] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      const [{ audits: saved }, docs] = await Promise.all([
        invokeAudit({ action: "list", token: identity?.token }),
        listDocuments(),
      ]);
      setAudits(saved || []);
      setDocuments(docs || []);
    } catch (error) {
      console.error("Failed to load hardware audits:", error);
      setErrorText("Could not load hardware schedule audits.");
    }
  }

  async function handleUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    setErrorText("");
    try {
      const document = await uploadDocument(file, identity);
      const { audit } = await invokeAudit({
        action: "create",
        document_id: document.id,
        project_name: file.name.replace(/\.[^.]+$/, ""),
        token: identity?.token,
      });
      const detail = await invokeAudit({ action: "get", audit_id: audit.id, token: identity?.token });
      setSelected(detail);
      refresh();
    } catch (error) {
      console.error("Hardware audit failed:", error);
      setErrorText("Hardware schedule audit failed. Please check the uploaded file.");
    } finally {
      setUploading(false);
    }
  }

  async function openAudit(auditId) {
    try {
      setSelected(await invokeAudit({ action: "get", audit_id: auditId, token: identity?.token }));
    } catch (error) {
      console.error("Failed to open audit:", error);
      setErrorText("Could not open that audit.");
    }
  }

  return (
    <main className="documents-main">
      <div className="documents-header">
        <h1>Hardware Schedule Audit</h1>
        <p>Upload a schedule and TYK will extract openings, hardware sets, quantities, ratings, finishes, patterns, and evidence-backed items to review.</p>
      </div>
      {errorText && <div className="inline-error">{errorText}</div>}
      <div className="documents-upload">
        <label className="upload-button">
          {uploading ? "Auditing…" : "Upload Hardware Schedule"}
          <input type="file" accept="application/pdf,.pdf,.csv,text/csv,text/plain,.txt" hidden disabled={uploading} onChange={handleUpload} />
        </label>
      </div>

      {selected && (
        <div className="teach-history">
          <div className="teach-history-label">Audit results · {selected.audit.project_name}</div>
          <div className="stats-grid">
            <div className="stats-card"><div className="stats-value">{selected.audit.openings_count}</div><div className="stats-label">Openings</div></div>
            <div className="stats-card"><div className="stats-value">{selected.audit.hardware_sets_count}</div><div className="stats-label">Hardware sets</div></div>
            <div className="stats-card"><div className="stats-value">{selected.audit.issues_count}</div><div className="stats-label">Items to review</div></div>
          </div>
          {(selected.findings || []).map((finding) => (
            <div className="teach-history-item" key={finding.id}>
              <div className="teach-history-question"><span className="document-tag">{finding.severity}</span> {finding.title}</div>
              <div className="teach-history-answer">{finding.description}</div>
              {finding.recommendation && <div className="document-meta">Recommendation: {finding.recommendation}</div>}
              <div className="document-meta">Evidence state: {finding.evidence?.state || "NEEDS_REVIEW"}</div>
            </div>
          ))}
        </div>
      )}

      <div className="teach-history">
        <div className="teach-history-label">Recent audits</div>
        {audits.map((audit) => (
          <button type="button" className="document-row audit-history-row" key={audit.id} onClick={() => openAudit(audit.id)}>
            <span className="document-row-main"><span className="document-name">{audit.project_name}</span><span className="document-meta">{audit.openings_count} openings · {audit.issues_count} items to review</span></span>
            <span className="doc-status doc-status-ok">{audit.status}</span>
          </button>
        ))}
        {!audits.length && <div className="documents-empty">No hardware schedule audits yet.</div>}
      </div>
    </main>
  );
}

export default HardwareAuditView;
