import { useRef, useState } from "react";
import { supabase } from "../utils/supabase";

async function searchDocuments(query) {
  const { data, error } = await supabase.functions.invoke("document-manager", {
    body: { action: "search", query },
  });
  if (error) throw error;
  return data?.documents || [];
}

async function searchConversations(query, identity) {
  const { data, error } = await supabase.functions.invoke("conversation-store", {
    body: { action: "search", query, token: identity?.token },
  });
  if (error) throw error;
  return data?.conversations || [];
}

// Deterministic (zero-AI) search across the shared document library and the
// user's own conversation titles - matches TYK's "answer without AI first"
// philosophy applied to search itself.
function SearchOverlay({ identity, onSelectConversation, onOpenDocuments, onClose }) {
  const [query, setQuery] = useState("");
  const [documents, setDocuments] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  function handleChange(value) {
    setQuery(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(value), 250);
  }

  async function runSearch(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      setDocuments([]);
      setConversations([]);
      return;
    }
    setLoading(true);
    try {
      const [docs, convos] = await Promise.all([
        searchDocuments(trimmed),
        searchConversations(trimmed, identity),
      ]);
      setDocuments(docs);
      setConversations(convos);
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="search-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="search-overlay-header">
          <input
            autoFocus
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            placeholder="Search documents and conversations…"
          />
          <button type="button" className="icon-button" onClick={onClose}>✕</button>
        </div>

        {loading && <div className="documents-empty">Searching…</div>}

        {!loading && query.trim() && documents.length === 0 && conversations.length === 0 && (
          <div className="documents-empty">No matches.</div>
        )}

        {conversations.length > 0 && (
          <div className="search-section">
            <div className="notifications-section-label">Conversations</div>
            {conversations.map((c) => (
              <button
                type="button"
                key={c.id}
                className="search-result"
                onClick={() => {
                  onSelectConversation(c.id);
                  onClose();
                }}
              >
                {c.title || "Untitled conversation"}
              </button>
            ))}
          </div>
        )}

        {documents.length > 0 && (
          <div className="search-section">
            <div className="notifications-section-label">Documents</div>
            {documents.map((d) => (
              <button
                type="button"
                key={d.id}
                className="search-result"
                onClick={() => {
                  onOpenDocuments();
                  onClose();
                }}
              >
                {d.name}
                {d.manufacturer && <span className="document-tag">{d.manufacturer}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default SearchOverlay;
