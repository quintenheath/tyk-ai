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

function formatTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatElapsed(value, now) {
  if (!value) return "—";
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds}s`;
}

function readAccordionState(key) {
  try {
    return sessionStorage.getItem(key) === "open";
  } catch {
    return false;
  }
}

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
  const [queueOpen, setQueueOpen] = useState(() => readAccordionState("tyk-research-queue"));
  const [historyOpen, setHistoryOpen] = useState(() => readAccordionState("tyk-research-history"));
  const [now, setNow] = useState(() => Date.now());

  const activeTask = queue.find((task) => task.status === "researching") || null;
  const queuedTasks = queue.filter((task) => ACTIVE_STATUSES.has(task.status) && task.status !== "researching");

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(interval);
  }, []);

  function toggleAccordion(key, setter, open) {
    setter(!open);
    try {
      sessionStorage.setItem(key, open ? "closed" : "open");
    } catch {
      // Session persistence is an enhancement, not a requirement for the view.
    }
  }

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

      {loading && <div className="documents-empty">Loading…</div>}

      {loadedSuccessfully && <>
        <section className="research-current-section">
          <div className="research-section-heading">
            <div>
              <div className="teach-history-label">Currently researching</div>
              <p className="research-section-subtitle">What TYK is working on right now.</p>
            </div>
            <div className="research-current-actions">
              <button type="button" className="upload-button" onClick={handleRunNow} disabled={running}>
                {running ? "Running…" : "Run research now"}
              </button>
              <button type="button" className="teach-skip-button" onClick={handleExportKnowledge} disabled={exporting}>
                {exporting ? "Preparing…" : "Export TYK Knowledge"}
              </button>
            </div>
          </div>

          {activeTask ? (
            <div className="research-active-card">
              <div className="research-active-topline">
                <div>
                  <div className="document-name">{activeTask.title || activeTask.topic}</div>
                  <div className="document-meta">
                    {activeTask.type && <span className="document-tag">{activeTask.type}</span>}
                    <span className="document-tag">Priority {activeTask.priority}</span>
                    <span className="document-tag">Researching</span>
                  </div>
                </div>
                <strong className="research-progress-value">{activeTask.progress_percent || 0}%</strong>
              </div>
              <div className="research-progress-track" aria-label={`Research progress ${activeTask.progress_percent || 0}%`}>
                <span style={{ width: `${Math.max(0, Math.min(100, activeTask.progress_percent || 0))}%` }} />
              </div>
              <div className="research-stage">{activeTask.progress_stage || "Initializing research"}</div>
              <div className="research-metrics">
                <div><span>Started</span><strong>{formatTime(activeTask.last_attempted_at || activeTask.updated_at)}</strong></div>
                <div><span>Elapsed</span><strong>{formatElapsed(activeTask.last_attempted_at || activeTask.updated_at, now)}</strong></div>
                <div><span>Sources checked</span><strong>{activeTask.sources_checked || 0}</strong></div>
                <div><span>Documents found</span><strong>{activeTask.documents_found || 0}</strong></div>
                <div><span>Knowledge updated</span><strong>{activeTask.knowledge_records_created || activeTask.knowledge_created || 0}</strong></div>
              </div>
              <div className="research-active-controls">
                <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(activeTask, "pause")}>Pause</button>
                <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(activeTask, "stop")}>Stop</button>
              </div>
            </div>
          ) : (
            <div className="research-ready-state">TYK is ready for its next research task.</div>
          )}
        </section>

        {health && (
          <div className="research-system-summary">
            <span>{health.documentsIndexed} documents indexed</span>
            <span>{health.researchQueue.queued} queued</span>
            <span>{health.documentStorage === "ok" ? "Storage OK" : "Storage status unknown"}</span>
            <span>{health.cadence?.label || "Server scheduled"}</span>
          </div>
        )}

        <section className="research-accordion">
          <button type="button" className="research-accordion-toggle" aria-expanded={queueOpen} onClick={() => toggleAccordion("tyk-research-queue", setQueueOpen, queueOpen)}>
            <span aria-hidden="true">{queueOpen ? "▼" : "▶"}</span>
            <span>Research Queue</span>
            <span className="research-accordion-count">{queuedTasks.length}</span>
          </button>
          {queueOpen && <div className="research-accordion-content">
            {queuedTasks.map((task) => (
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
              <div className="document-meta">Created {formatTime(task.created_at)} · Last attempted {formatTime(task.last_attempted_at)} · Next attempt {formatTime(task.next_attempt_at || task.next_research_date)}</div>
            </div>
            <div className="document-row-actions">
              <div className={statusClass(task.status)}>{STATUS_LABELS[task.status] || task.status}</div>
              {task.status === "queued" && <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(task, "prioritize")}>Prioritize</button>}
              {(task.status === "paused" || task.status === "stopped") && <button type="button" className="teach-skip-button" onClick={() => handleTaskAction(task, "start")}>Restart</button>}
            </div>
          </div>
            ))}
            {!queuedTasks.length && <div className="documents-empty">No queued research work.</div>}
          </div>}
        </section>

        <section className="research-accordion">
          <button type="button" className="research-accordion-toggle" aria-expanded={historyOpen} onClick={() => toggleAccordion("tyk-research-history", setHistoryOpen, historyOpen)}>
            <span aria-hidden="true">{historyOpen ? "▼" : "▶"}</span>
            <span>Research History</span>
            <span className="research-accordion-count">{log.length}</span>
          </button>
          {historyOpen && <div className="research-accordion-content">
            {log.map((entry) => (
              <div className="teach-history-item" key={entry.id}>
                <div className="teach-history-question">{entry.task_topic}</div>
                <div className="document-meta">
                  <span className={statusClass(entry.failures ? "failed" : "done")}>{entry.failures ? "Failed" : "Completed"}</span>
                  <span>Started {formatTime(entry.started_at || entry.created_at)}</span>
                  <span>Completed {formatTime(entry.completed_at || entry.created_at)}</span>
                  <span>Sources {entry.sources_checked || entry.documents_found || 0}</span>
                  <span>Documents {entry.documents_found || 0}</span>
                  <span>Knowledge {entry.knowledge_created || entry.knowledge_records_created || 0}</span>
                </div>
                <div className="teach-history-answer">
                  {entry.result || entry.failures || "No result recorded."}
                </div>
              </div>
            ))}
            {!log.length && <div className="documents-empty">No research runs logged yet.</div>}
          </div>}
        </section>
      </>}
    </main>
  );
}

export default ResearchView;
