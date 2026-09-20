import { useEffect, useState } from "react";
import { supabase } from "../utils/supabase";
import { exportTykKnowledge } from "../utils/documents";

const STATUS_LABELS = {
  queued: "Queued",
  researching: "Researching…",
  paused: "Paused",
  stopped: "Stopped",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

const ACTIVE_STATUSES = new Set(["queued", "researching", "reverify", "needs_review"]);

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
  const [loadedSuccessfully, setLoadedSuccessfully] = useState(false);
  const [running, setRunning] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [exporting, setExporting] = useState(false);

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
    setLoading(true);
    setErrorText("");
    setLoadedSuccessfully(false);
    try {
      const [{ queue: q }, { log: l }, { health: h }] = await Promise.all([
        invokeResearch({ action: "queue", token: identity?.token }),
        invokeResearch({ action: "log", token: identity?.token }),
        invokeResearch({ action: "health", token: identity?.token }),
      ]);
      setQueue(q || []);
      setLog(l || []);
      setHealth(h || null);
      setLoadedSuccessfully(true);
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

  async function handleExportKnowledge() {
    setExporting(true);
    try {
      const { url } = await exportTykKnowledge(identity);
      const link = document.createElement("a");
      link.href = url;
      link.click();
    } catch (err) {
      console.error("Failed to export TYK knowledge:", err);
      setErrorText("Couldn't export TYK knowledge right now.");
    } finally {
      setExporting(false);
    }
  }

  async function handleTaskAction(task, action) {
    try {
      await invokeResearch({ action, task_id: task.id, token: identity?.token });
      await refresh();
    } catch (err) {
      console.error("Failed to update research task:", err);
      setErrorText("Could not update that research task.");
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

      {errorText && (
        <div className="inline-error research-load-error">
          <span>{errorText}</span>
          <button type="button" className="teach-skip-button" onClick={refresh}>Retry</button>
        </div>
      )}

      <div className="documents-upload">
        <button type="button" className="upload-button" onClick={handleRunNow} disabled={running}>
          {running ? "Running…" : "Run research now"}
        </button>
        <button type="button" className="teach-skip-button" onClick={handleExportKnowledge} disabled={exporting}>
          {exporting ? "Preparing…" : "Export TYK Knowledge"}
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
          <div className="stats-card">
            <div className="stats-value">{health.researchQueue.researching || 0}</div>
            <div className="stats-label">Researching now</div>
          </div>
          <div className="stats-card">
            <div className="stats-value">{health.researchQueue.completedToday || 0}</div>
            <div className="stats-label">Completed today</div>
          </div>
          <div className="stats-card">
            <div className="stats-value">{health.cadence?.label || "Server scheduled"}</div>
            <div className="stats-label">
              Next cycle {health.cadence?.nextRunAt ? new Date(health.cadence.nextRunAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "scheduled"}
            </div>
          </div>
        </div>
      )}

      {loadedSuccessfully && <div className="teach-history">
        <div className="teach-history-label">Currently researching</div>
        {queue.filter((task) => task.status === "researching").map((task) => (
          <div className="document-row" key={task.id}>
            <div className="document-row-main">
              <div className="document-name">{task.title || task.topic}</div>
              <div className="document-meta">{task.reason || "Active research cycle"}</div>
            </div>
            <div className="doc-status doc-status-pending">Researching…</div>
          </div>
        ))}
        {queue.filter((task) => task.status === "researching").length === 0 && (
          <div className="documents-empty">Waiting for the next server-side research cycle.</div>
        )}
      </div>}

      {loadedSuccessfully && <div className="teach-history">
        <div className="teach-history-label">Queued to research</div>
        {queue.filter((task) => ACTIVE_STATUSES.has(task.status) && task.status !== "researching").map((task) => (
          <div className="document-row" key={task.id}>
            <div className="document-row-main">
              <div className="document-name">{task.title || task.topic}</div>
              <div className="document-meta">
                {task.type && <span className="document-tag">{task.type}</span>}
                {task.source_type && <span className="document-tag">{task.source_type}</span>}
                <span className="document-tag">priority {task.priority}</span>
                {task.manually_prioritized && <span className="document-tag">PRIORITY RESEARCH</span>}
                {task.entity_name && <span className="document-tag">{task.entity_name}</span>}
              </div>
              {(task.status === "researching" || task.status === "paused" || task.status === "stopped") && (
                <div className="document-meta">
                  {task.progress_percent || 0}% · {task.progress_stage || "Initializing research"}
                </div>
              )}
              {task.status === "done" && task.result && (
                <div className="document-meta">{task.result}</div>
              )}
              {task.status !== "done" && task.reason && (
                <div className="document-meta">{task.reason}</div>
              )}
            </div>
            <div className="document-row-actions">
              <div className={statusClass(task.status)}>{STATUS_LABELS[task.status] || task.status}</div>
              {task.status === "researching" && <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(task, "pause")}>Pause</button>}
              {task.status === "researching" && <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(task, "stop")}>Stop</button>}
              {task.status === "queued" && <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(task, "prioritize")}>Prioritize</button>}
              {(task.status === "paused" || task.status === "stopped") && <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(task, "start")}>Restart</button>}
            </div>
          </div>
        ))}
        {!loading && queue.filter((task) => ACTIVE_STATUSES.has(task.status) && task.status !== "researching").length === 0 && (
          <div className="documents-empty">No queued research work.</div>
        )}
      </div>}

      {loadedSuccessfully && <div className="teach-history">
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
      </div>}
    </main>
  );
}

export default ResearchView;
