import { useEffect, useState } from "react";
import { supabase } from "../utils/supabase";
import { approvePromotion, listPendingPromotions } from "../utils/conversations";

const SOURCE_LABELS = {
  calculator: "Calculator",
  documents_table: "Document metadata",
  keyword_search: "Keyword search",
  "keyword_search+extraction": "Keyword search + extraction",
  learned_knowledge_reuse: "Reused learned answer",
  "vector_search+ai_reasoning": "Knowledge search + AI",
  "attached_documents+ai_reasoning": "Attached documents + AI",
  vision_model: "Vision model",
  ai_reasoning_failed: "AI call failed",
};

function SettingsView({ identity }) {
  const [stats, setStats] = useState(null);
  const [sources, setSources] = useState([]);
  const [pending, setPending] = useState([]);
  const [activeWork, setActiveWork] = useState([]);
  const [researchCount, setResearchCount] = useState(0);
  const [checkingProvider, setCheckingProvider] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");
  const canApprove = identity?.permissions?.can_approve_company_knowledge;

  useEffect(() => {
    supabase.functions
      .invoke("usage-stats", { body: {} })
      .then(({ data, error }) => {
        if (error) throw error;
        if (data?.error) throw new Error(data.error);
        setStats(data);
      })
      .catch((err) => {
        console.error("Failed to load usage stats:", err);
        setErrorText("Couldn't load usage stats.");
      })
      .finally(() => setLoading(false));

    loadSources();
    if (canApprove) loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadPending() {
    try {
      const items = await listPendingPromotions(identity);
      setPending(items);
      const { data, error } = await supabase.functions.invoke("background-research", {
        body: { action: "queue", token: identity?.token },
      });
      if (!error && !data?.error) {
        const researchStatuses = new Set(["queued", "researching", "reverify", "needs_review", "failed"]);
        const work = (data.queue || []).filter((task) => researchStatuses.has(task.status));
        setResearchCount(work.length);
        setActiveWork(work.slice(0, 8));
      }
    } catch (err) {
      console.error("Failed to load pending company knowledge:", err);
    }
  }

  async function handleApprove(id, approve) {
    setPending((prev) => prev.filter((p) => p.id !== id));
    try {
      await approvePromotion(identity, id, approve);
    } catch (err) {
      console.error("Failed to review pending knowledge:", err);
      loadPending();
    }
  }

  async function loadSources() {
    try {
      const { data, error } = await supabase.functions.invoke(
        "connected-sources",
        { body: { action: "list" } },
      );
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setSources(data.sources || []);
    } catch (err) {
      console.error("Failed to load connected sources:", err);
    }
  }

  async function checkConnection(provider) {
    setCheckingProvider(provider);
    try {
      const { data, error } = await supabase.functions.invoke(
        "connected-sources",
        { body: { action: "check", provider } },
      );
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      await loadSources();
    } catch (err) {
      console.error("Failed to check connection:", err);
    } finally {
      setCheckingProvider(null);
    }
  }

  return (
    <main className="documents-main">
      <div className="documents-header">
        <h1>Settings</h1>
        <p>
          TYK's goal is to answer as many questions as possible without
          calling an AI provider. This shows how it's doing.
        </p>
      </div>

      {errorText && <div className="inline-error">{errorText}</div>}
      {loading && <div className="documents-empty">Loading…</div>}

      {stats && (
        <>
          <div className="stats-grid">
            <div className="stats-card">
              <div className="stats-value">{stats.zeroAiPercent}%</div>
              <div className="stats-label">Answered with zero AI calls</div>
            </div>
            <div className="stats-card">
              <div className="stats-value">{stats.total}</div>
              <div className="stats-label">Questions tracked (last 1000)</div>
            </div>
            <div className="stats-card">
              <div className="stats-value">{stats.avgLatencyMs ?? "—"}</div>
              <div className="stats-label">Avg latency (ms)</div>
            </div>
            <div className="stats-card">
              <div className="stats-value">{stats.failedCount}</div>
              <div className="stats-label">Failed AI calls</div>
            </div>
          </div>

          <div className="teach-history">
            <div className="teach-history-label">Answer source breakdown</div>
            {Object.entries(stats.bySource)
              .sort((a, b) => b[1] - a[1])
              .map(([source, count]) => (
                <div className="teach-history-item" key={source}>
                  <div className="teach-history-question">
                    {SOURCE_LABELS[source] || source}
                  </div>
                  <div className="teach-history-answer">{count} question(s)</div>
                </div>
              ))}
            {stats.total === 0 && (
              <div className="documents-empty">
                No questions tracked yet - ask TYK something to see stats here.
              </div>
            )}
          </div>
        </>
      )}

      <div className="teach-history">
        <div className="teach-history-label">Connected Sources</div>
        {sources.map((source) => (
          <div className="document-row" key={source.id}>
            <div className="document-row-main">
              <div className="document-name">{source.name}</div>
              <div className="document-meta">
                <span className="document-tag">{source.authentication_status}</span>
                {source.capabilities?.map((cap) => (
                  <span className="document-tag" key={cap}>{cap}</span>
                ))}
              </div>
              {source.last_error && (
                <div className="document-error">{source.last_error}</div>
              )}
            </div>

            <div
              className={
                "doc-status " +
                (source.status === "connected"
                  ? "doc-status-ok"
                  : source.status === "error"
                  ? "doc-status-error"
                  : "doc-status-pending")
              }
            >
              {source.status}
            </div>

            <button
              type="button"
              className="teach-skip-button"
              onClick={() => checkConnection(source.provider)}
              disabled={checkingProvider === source.provider}
            >
              {checkingProvider === source.provider ? "…" : "Check Connection"}
            </button>
          </div>
        ))}
        {sources.length === 0 && (
          <div className="documents-empty">No connected sources configured yet.</div>
        )}
      </div>

      {canApprove && (
        <div className="teach-history">
          <div className="teach-history-label">
            Pending company knowledge
            {researchCount > 0 && ` · ${researchCount} research tasks waiting`}
          </div>

          {pending.length > 0 && (
            <div className="documents-header-note">Teach TYK approvals</div>
          )}
          {pending.map((item) => (
            <div className="teach-history-item" key={item.id}>
              <div className="teach-history-question">{item.question}</div>
              <div className="teach-history-answer">{item.answer}</div>
              <div className="teach-answer-actions">
                <button type="button" className="teach-skip-button" onClick={() => handleApprove(item.id, false)}>
                  Reject
                </button>
                <button type="button" className="send-button teach-yes-button" onClick={() => handleApprove(item.id, true)}>
                  Approve
                </button>
              </div>
            </div>
          ))}

          {activeWork.length > 0 && (
            <>
              <div className="documents-header-note">TYK research</div>
              {activeWork.map((task) => (
                <div className="teach-history-item" key={task.id}>
                  <div className="teach-history-question">
                    {task.title || task.topic}
                    <span className="document-tag">{task.type}</span>
                  </div>
                  <div className="teach-history-answer">
                    {task.status === "done" ? task.result : task.reason || "Queued"}
                  </div>
                </div>
              ))}
            </>
          )}

          {pending.length === 0 && activeWork.length === 0 && (
            <div className="documents-empty">Research queue is replenishing.</div>
          )}
        </div>
      )}
    </main>
  );
}

export default SettingsView;
