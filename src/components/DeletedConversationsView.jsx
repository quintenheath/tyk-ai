import { useEffect, useState } from "react";
import {
  listDeletedConversations,
  loadDeletedConversation,
  restoreConversation,
} from "../utils/conversations";

function DeletedConversationsView({ identity, onOpenConversation, onRestored }) {
  const [items, setItems] = useState([]);
  const [users, setUsers] = useState([]);
  const [filters, setFilters] = useState({ topic: "", target_user_id: "", from: "", to: "" });
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");

  async function refresh() {
    setLoading(true);
    setErrorText("");
    try {
      const result = await listDeletedConversations(filters, identity);
      const next = result.conversations || [];
      setItems(next);
      setUsers(result.users || [...new Map(next.filter((item) => item.owner?.id).map((item) => [item.owner.id, item.owner])).values()]);
    } catch (error) {
      console.error("Failed to load deleted conversations:", error);
      setErrorText("Could not load deleted conversations.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.topic, filters.target_user_id, filters.from, filters.to]);

  async function openConversation(id) {
    try {
      const result = await loadDeletedConversation(id, identity);
      onOpenConversation?.(result.conversation, result.messages || []);
    } catch (error) {
      console.error("Failed to open deleted conversation:", error);
      setErrorText("Could not open that deleted conversation.");
    }
  }

  async function restore(id) {
    try {
      await restoreConversation(id, identity);
      setItems((current) => current.filter((item) => item.id !== id));
      onRestored?.();
    } catch (error) {
      console.error("Failed to restore conversation:", error);
      setErrorText("Could not restore that conversation.");
    }
  }

  return (
    <main className="documents-main">
      <div className="documents-header">
        <h1>Deleted Conversations</h1>
        <p>Quinten-only recovery for soft-deleted conversations. Messages and related records remain intact.</p>
      </div>
      {errorText && <div className="inline-error">{errorText}</div>}
      <div className="deleted-conversation-filters">
        <input value={filters.topic} placeholder="Search topic or project" onChange={(event) => setFilters((current) => ({ ...current, topic: event.target.value }))} />
        <select value={filters.target_user_id} onChange={(event) => setFilters((current) => ({ ...current, target_user_id: event.target.value }))}>
          <option value="">All users</option>
          {users.map((user) => <option value={user.id} key={user.id}>{user.name} · {user.role}</option>)}
        </select>
        <input type="date" value={filters.from} aria-label="Deleted from" onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
        <input type="date" value={filters.to} aria-label="Deleted to" onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
      </div>
      {loading ? <div className="documents-empty">Loading…</div> : !items.length ? <div className="documents-empty">No deleted conversations found.</div> : (
        <div className="teach-history">
          {items.map((item) => (
            <div className="document-row" key={item.id}>
              <div className="document-row-main">
                <div className="document-name">{item.title || "New conversation"}</div>
                <div className="document-meta">{item.owner?.name || "Temporary session"} · Deleted by {item.deleted_by_name} · {new Date(item.deleted_at).toLocaleString()}</div>
                {item.topic_summary && <div className="document-meta">{item.topic_summary}</div>}
              </div>
              <button type="button" className="teach-skip-button" onClick={() => openConversation(item.id)}>View</button>
              <button type="button" className="teach-skip-button" onClick={() => restore(item.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

export default DeletedConversationsView;