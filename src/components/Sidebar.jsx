import { useState } from "react";
import { groupConversationsByRecency } from "../utils/conversations";

const NAV_ITEMS = [
  { id: "documents", label: "📄 Documents", permission: "can_upload_documents" },
  { id: "teach", label: "🧠 Teach TYK", permission: "can_teach_tyk" },
];

const CALL_ITEMS = [
  { id: "call", label: "📞 Call TYK" },
  { id: "facetime", label: "🎥 FaceTime TYK" },
];

function Sidebar({
  conversations,
  activeConversationId,
  activeView,
  identity,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onRenameConversation,
  onSelectView,
  onStartOverlay,
}) {
  const groups = groupConversationsByRecency(conversations);
  const [editingId, setEditingId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");

  const navItems = [
    ...NAV_ITEMS.filter((item) => identity?.permissions?.[item.permission] !== false),
    ...(identity?.permissions?.can_view_research ? [{ id: "research", label: "🔭 Research" }] : []),
    ...(identity?.role === "admin" ? [{ id: "users", label: "👤 Users" }] : []),
  ];

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

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              "sidebar-nav-item" + (activeView === item.id ? " active" : "")
            }
            onClick={() => onSelectView(item.id)}
          >
            {item.label}
          </button>
        ))}
        {CALL_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="sidebar-nav-item"
            onClick={() => onStartOverlay(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

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
