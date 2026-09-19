import { useState } from "react";
import { groupConversationsByRecency } from "../utils/conversations";

function Sidebar({
  conversations,
  activeConversationId,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
}) {
  const groups = groupConversationsByRecency(conversations);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");

  function startEditing(conversation) {
    setEditingId(conversation.id);
    setEditingTitle(conversation.title || "");
  }

  function commitRename() {
    const title = editingTitle.trim();
    if (title && editingId) {
      onRenameConversation(editingId, title);
    }
    setEditingId(null);
  }

  return (
    <aside className="sidebar">
      <button className="new-chat-button" onClick={onNewChat}>
        <span>＋</span> New Chat
      </button>

      <div className="conversation-list">
        {groups.length === 0 && (
          <div className="conversation-empty">No conversations yet</div>
        )}

        {groups.map(([label, items]) => (
          <div className="conversation-group" key={label}>
            <div className="conversation-group-label">{label}</div>

            {items.map((conversation) => (
              <div
                key={conversation.id}
                className={
                  "conversation-item" +
                  (conversation.id === activeConversationId ? " active" : "")
                }
                onClick={() => onSelectConversation(conversation.id)}
              >
                {editingId === conversation.id ? (
                  <input
                    autoFocus
                    className="conversation-rename-input"
                    value={editingTitle}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                ) : (
                  <span
                    className="conversation-title"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startEditing(conversation);
                    }}
                    title="Double-click to rename"
                  >
                    {conversation.title || "New conversation"}
                  </span>
                )}
                <button
                  type="button"
                  className="conversation-delete"
                  title="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteConversation(conversation.id);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

export default Sidebar;
