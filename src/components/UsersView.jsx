import { useEffect, useState } from "react";
import {
  createUser,
  listRoleDefaults,
  listUsers,
  resetPassword,
  updateRoleDefaults,
  updateUser,
} from "../utils/auth";

const ROLES = ["admin", "office"];
const ALL_ROLES = ["admin", "office", "installer", "other"];
const PERMISSION_KEYS = [
  ["can_teach_tyk", "Teach TYK"],
  ["can_approve_company_knowledge", "Approve company knowledge"],
  ["can_upload_documents", "Upload documents"],
  ["can_manage_documents", "Delete documents"],
  ["can_manage_users", "Manage users"],
  ["can_view_settings", "View settings"],
  ["can_view_research", "View research dashboard"],
];

function PermissionCheckboxes({ permissions, onChange }) {
  return (
    <div className="permissions-grid">
      {PERMISSION_KEYS.map(([key, label]) => (
        <label key={key} className="permission-checkbox">
          <input
            type="checkbox"
            checked={permissions?.[key] === true}
            onChange={(e) => onChange({ ...permissions, [key]: e.target.checked })}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

function UsersView({ identity }) {
  const [users, setUsers] = useState([]);
  const [roleDefaults, setRoleDefaults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState("");

  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState("office");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const [resetTarget, setResetTarget] = useState(null);
  const [resetValue, setResetValue] = useState("");
  const [editingPermissionsFor, setEditingPermissionsFor] = useState(null);
  const [editingRoleDefault, setEditingRoleDefault] = useState(null);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    setLoading(true);
    setErrorText("");
    try {
      const [u, d] = await Promise.all([listUsers(identity), listRoleDefaults(identity)]);
      setUsers(u);
      setRoleDefaults(d);
    } catch (err) {
      setErrorText(err.message || "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim() || !newPassword || creating) return;
    setCreating(true);
    setErrorText("");
    try {
      await createUser(identity, {
        name: newName.trim(),
        role: newRole,
        password: newPassword,
      });
      setNewName("");
      setNewPassword("");
      refresh();
    } catch (err) {
      setErrorText(err.message || "Failed to create user.");
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleDisabled(user) {
    try {
      await updateUser(identity, user.id, { disabled: !user.disabled });
      refresh();
    } catch (err) {
      setErrorText(err.message || "Failed to update user.");
    }
  }

  async function handleRoleChange(user, role) {
    try {
      await updateUser(identity, user.id, { role });
      refresh();
    } catch (err) {
      setErrorText(err.message || "Failed to update user.");
    }
  }

  async function handlePermissionsChange(user, permissions) {
    setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, permissions } : u)));
    try {
      await updateUser(identity, user.id, { permissions });
    } catch (err) {
      setErrorText(err.message || "Failed to update permissions.");
      refresh();
    }
  }

  async function handleRoleDefaultChange(role, permissions) {
    setRoleDefaults((prev) => prev.map((d) => (d.role === role ? { ...d, permissions } : d)));
    try {
      await updateRoleDefaults(identity, role, permissions);
    } catch (err) {
      setErrorText(err.message || "Failed to update role defaults.");
      refresh();
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    if (!resetTarget || !resetValue) return;
    try {
      await resetPassword(identity, resetTarget.id, resetValue);
      setResetTarget(null);
      setResetValue("");
    } catch (err) {
      setErrorText(err.message || "Failed to reset password.");
    }
  }

  return (
    <main className="documents-main">
      <div className="documents-header">
        <h1>Users</h1>
        <p>
          Only persistent Admin/Office accounts appear here. Installer and
          Other access is temporary and never creates a named account.
        </p>
      </div>

      {errorText && <div className="inline-error">{errorText}</div>}

      <form className="teach-answer-form users-create-form" onSubmit={handleCreate}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Name"
        />
        <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="Password"
        />
        <button type="submit" disabled={creating || !newName.trim() || !newPassword}>
          {creating ? "Adding…" : "Add user"}
        </button>
      </form>

      {loading && <div className="documents-empty">Loading…</div>}

      <div className="teach-history">
        {users.map((user) => (
          <div className="document-row users-row" key={user.id}>
            <div className="users-row-top">
              <div className="document-row-main">
                <div className="document-name">{user.name}</div>
                <div className="document-meta">
                  <select
                    value={user.role}
                    onChange={(e) => handleRoleChange(user, e.target.value)}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  {user.disabled && <span className="document-tag">disabled</span>}
                </div>
              </div>

              {resetTarget?.id === user.id ? (
                <form className="users-reset-form" onSubmit={handleResetPassword}>
                  <input
                    type="password"
                    autoFocus
                    value={resetValue}
                    onChange={(e) => setResetValue(e.target.value)}
                    placeholder="New password"
                  />
                  <button type="submit" className="teach-skip-button">Save</button>
                  <button
                    type="button"
                    className="teach-skip-button"
                    onClick={() => setResetTarget(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="teach-skip-button"
                  onClick={() => {
                    setResetTarget(user);
                    setResetValue("");
                  }}
                >
                  Reset password
                </button>
              )}

              <button
                type="button"
                className="teach-skip-button"
                onClick={() =>
                  setEditingPermissionsFor(editingPermissionsFor === user.id ? null : user.id)
                }
              >
                {editingPermissionsFor === user.id ? "Hide permissions" : "Permissions"}
              </button>

              <button
                type="button"
                className="teach-skip-button"
                onClick={() => handleToggleDisabled(user)}
              >
                {user.disabled ? "Enable" : "Disable"}
              </button>
            </div>

            {editingPermissionsFor === user.id && (
              <PermissionCheckboxes
                permissions={user.permissions}
                onChange={(p) => handlePermissionsChange(user, p)}
              />
            )}
          </div>
        ))}
        {!loading && users.length === 0 && (
          <div className="documents-empty">No persistent users yet.</div>
        )}
      </div>

      <div className="teach-history">
        <div className="teach-history-label">Role defaults</div>
        <p className="documents-header-note">
          What a brand-new account or temporary Installer/Other session starts
          with. Existing accounts keep their own permissions when this changes.
        </p>
        {ALL_ROLES.map((role) => {
          const entry = roleDefaults.find((d) => d.role === role);
          return (
            <div className="document-row users-row" key={role}>
              <div className="users-row-top">
                <div className="document-name">{role}</div>
                <button
                  type="button"
                  className="teach-skip-button"
                  onClick={() => setEditingRoleDefault(editingRoleDefault === role ? null : role)}
                >
                  {editingRoleDefault === role ? "Hide" : "Edit"}
                </button>
              </div>
              {editingRoleDefault === role && (
                <PermissionCheckboxes
                  permissions={entry?.permissions}
                  onChange={(p) => handleRoleDefaultChange(role, p)}
                />
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}

export default UsersView;

