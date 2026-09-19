import { useEffect, useState } from "react";
import { supabase } from "../utils/supabase";
import { listPendingPromotions } from "../utils/conversations";

async function invokeResearch(payload) {
  const { data, error } = await supabase.functions.invoke("background-research", {
    body: payload,
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

// A lightweight "what's new" feed - reuses data that already exists
// (pending company-knowledge suggestions, research discoveries/changes)
// instead of a separate notifications table. Subscribes to Realtime so an
// admin sees new items appear without needing to visit Settings/Research.
function NotificationsBell({ identity }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState([]);
  const [research, setResearch] = useState([]);

  const canApprove = identity?.permissions?.can_approve_company_knowledge;
  const canViewResearch = identity?.permissions?.can_view_research;

  useEffect(() => {
    if (!canApprove && !canViewResearch) return;
    refresh();

    const channel = supabase
      .channel("notifications-live")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "learned_answers" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "research_log" }, refresh)
      .subscribe();

    return () => supabase.removeChannel(channel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      if (canApprove) {
        setPending(await listPendingPromotions(identity));
      }
      if (canViewResearch) {
        const { log } = await invokeResearch({ action: "log", token: identity?.token });
        setResearch((log || []).filter((entry) => entry.failures || entry.changes_discovered).slice(0, 8));
      }
    } catch (err) {
      console.error("Failed to load notifications:", err);
    }
  }

  if (!canApprove && !canViewResearch) return null;

  const count = pending.length + research.length;

  return (
    <div className="notifications-bell">
      <button
        type="button"
        className="icon-button"
        onClick={() => setOpen((v) => !v)}
        title="What's new"
      >
        🔔
        {count > 0 && <span className="notifications-badge">{count}</span>}
      </button>

      {open && (
        <div className="notifications-dropdown">
          {canApprove && (
            <div className="notifications-section">
              <div className="notifications-section-label">Pending company knowledge</div>
              {pending.length === 0 && <div className="documents-empty">Nothing pending.</div>}
              {pending.map((item) => (
                <div className="notifications-item" key={item.id}>
                  {item.question}
                </div>
              ))}
            </div>
          )}
          {canViewResearch && (
            <div className="notifications-section">
              <div className="notifications-section-label">Research issues</div>
              {research.length === 0 && <div className="documents-empty">Nothing requiring attention.</div>}
              {research.map((item) => (
                <div className="notifications-item" key={item.id}>
                  {item.task_topic} - {item.result}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationsBell;
