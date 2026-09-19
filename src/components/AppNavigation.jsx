const NAV_ITEMS = [
  { id: "home", label: "TYK", icon: "✦" },
  { id: "documents", label: "Documents", icon: "📄", permission: "can_upload_documents" },
  { id: "teach", label: "Teach TYK", icon: "🧠", permission: "can_teach_tyk" },
  { id: "research", label: "Research", icon: "🔭", permission: "can_view_research" },
  { id: "audit", label: "Hardware Schedule Audit", icon: "🧾", permission: "can_upload_documents" },
  { id: "settings", label: "Settings", icon: "⚙", permission: "can_view_settings" },
];

function AppNavigation({ identity, isOpen, onSelectView, onStartOverlay, onClose }) {
  const navItems = NAV_ITEMS.filter(
    (item) => !item.permission || identity?.permissions?.[item.permission] !== false,
  );

  if (identity?.role === "admin") {
    navItems.push({ id: "users", label: "Users", icon: "👤" });
  }

  return (
    <>
      <div
        className={"app-navigation-backdrop" + (isOpen ? " open" : "")}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        id="app-navigation"
        className={"app-navigation" + (isOpen ? " open" : "")}
        aria-label="Application navigation"
        aria-hidden={!isOpen}
      >
        <div className="app-navigation-header">
          <div className="brand-mark">T</div>
          <div>
            <div className="app-navigation-title">TYK</div>
            <div className="brand-subtitle">Application areas</div>
          </div>
          <button
            type="button"
            className="icon-button app-navigation-close"
            onClick={onClose}
            aria-label="Close navigation"
          >
            ✕
          </button>
        </div>

        <nav className="app-navigation-list">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className="app-navigation-item"
              onClick={() => {
                onSelectView(item.id);
                onClose();
              }}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className="app-navigation-item"
            onClick={() => {
              onStartOverlay("call");
              onClose();
            }}
          >
            <span aria-hidden="true">📞</span>
            Call TYK
          </button>
          <button
            type="button"
            className="app-navigation-item"
            onClick={() => {
              onStartOverlay("facetime");
              onClose();
            }}
          >
            <span aria-hidden="true">🎥</span>
            FaceTime TYK
          </button>
        </nav>
      </aside>
    </>
  );
}

export default AppNavigation;
