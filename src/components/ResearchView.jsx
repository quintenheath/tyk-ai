import { useEffect, useState } from "react";
import { supabase } from "../utils/supabase";

const STATUS_LABELS = {
  queued: "Queued",
  researching: "Researching…",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

function statusClass(status) {
  if (status === "done") return "doc-status doc-status-ok";
  if (status === "failed") return "doc-status doc-status-error";
  return "doc-status doc-status-pending";
}

async function invokeResearch(payload) {
  const { data, error } = await supabase.functions.invoke("background-research", {
    body: payload,
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

function ResearchView({ identity }) {
  const [queue, setQueue] = useState([]);
  const [log, setLog] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    refresh();

    // Live: research happens in the background on a schedule, so this view
    // should update itself as new tasks/log entries appear - never requires
    // a manual reload to see what TYK has been learning.
    const channel = supabase
      .channel("research-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "research_queue" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "research_log" }, refresh)
      .subscribe();

    return () => supabase.removeChannel(channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setErrorText("");
    try {
      const [{ queue: q }, { log: l }, { health: h }] = await Promise.all([
        invokeResearch({ action: "queue", token: identity?.token }),
        invokeResearch({ action: "log", token: identity?.token }),
        invokeResearch({ action: "health", token: identity?.token }),
      ]);
      setQueue(q || []);
      setLog(l || []);
      setHealth(h || null);
    } catch (err) {
      console.error("Failed to load research dashboard:", err);
      setErrorText("Couldn't load the research dashboard.");
    } finally {
      setLoading(false);
    }
  }

  async function handleRunNow() {
    setRunning(true);
    setErrorText("");
    try {
      await invokeResearch({ token: identity?.token });
      await refresh();
    } catch (err) {
      console.error("Failed to run research:", err);
      setErrorText("Couldn't run background research right now.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="documents-main">
      <div className="documents-header">
        <h1>Background Research</h1>
        <p>
          TYK keeps researching Ontario codes, suppliers, and manufacturers
          on a schedule, even when nobody is logged in. This shows what it's
          learned and what's still queued.
        </p>
      </div>

      {errorText && <div className="inline-error">{errorText}</div>}

      <div className="documents-upload">
        <button type="button" className="upload-button" onClick={handleRunNow} disabled={running}>
          {running ? "Running…" : "Run research now"}
        </button>
      </div>

      {loading && <div className="documents-empty">Loading…</div>}

      {health && (
        <div className="stats-grid">
          <div className="stats-card">
            <div className="stats-value">{health.documentsIndexed}</div>
            <div className="stats-label">Documents indexed</div>
          </div>
          <div className="stats-card">
            <div className="stats-value">{health.researchQueue.queued}</div>
            <div className="stats-label">Tasks queued</div>
          </div>
          <div className="stats-card">
            <div className="stats-value">
              {health.aiProviders.filter((p) => p.status === "ok").length}/{health.aiProviders.length || 0}
            </div>
            <div className="stats-label">AI providers healthy</div>
          </div>
          <div className="stats-card">
            <div className="stats-value">{health.documentStorage === "ok" ? "OK" : "?"}</div>
            <div className="stats-label">Document storage</div>
          </div>
        </div>
      )}

      <div className="teach-history">
        <div className="teach-history-label">Research queue</div>
        {queue.map((task) => (
          <div className="document-row" key={task.id}>
            <div className="document-row-main">
              <div className="document-name">{task.title || task.topic}</div>
              <div className="document-meta">
                {task.type && <span className="document-tag">{task.type}</span>}
                {task.source_type && <span className="document-tag">{task.source_type}</span>}
                <span className="document-tag">priority {task.priority}</span>
                {task.entity_name && <span className="document-tag">{task.entity_name}</span>}
              </div>
              {task.status === "done" && task.result && (
                <div className="document-meta">{task.result}</div>
              )}
              {task.status !== "done" && task.reason && (
                <div className="document-meta">{task.reason}</div>
              )}
            </div>
            <div className={statusClass(task.status)}>{STATUS_LABELS[task.status] || task.status}</div>
          </div>
        ))}
        {!loading && queue.length === 0 && (
          <div className="documents-empty">No research tasks yet.</div>
        )}
      </div>

      <div className="teach-history">
        <div className="teach-history-label">Recent research log</div>
        {log.map((entry) => (
          <div className="teach-history-item" key={entry.id}>
            <div className="teach-history-question">{entry.task_topic}</div>
            <div className="teach-history-answer">
              {entry.result || entry.failures || "No result recorded."}
              {entry.documents_found > 0 && ` · ${entry.documents_found} document(s) found`}
              {entry.ai_calls > 0 && ` · ${entry.ai_calls} AI call(s)`}
            </div>
          </div>
        ))}
        {!loading && log.length === 0 && (
          <div className="documents-empty">No research runs logged yet.</div>
        )}
      </div>
    </main>
  );
}

export default ResearchView;
