import { useEffect, useState } from "react";
import { listLoginUsers, login, startTempSession } from "../utils/auth";

function LoginScreen({ onLogin }) {
  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [tempLoading, setTempLoading] = useState(null);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    listLoginUsers()
      .then((list) => {
        setUsers(list);
        if (list.length) setSelectedUserId(list[0].id);
      })
      .catch((err) => console.error("Failed to load users:", err));
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    if (!selectedUserId || !password || submitting) return;
    setSubmitting(true);
    setErrorText("");
    try {
      const identity = await login(selectedUserId, password);
      onLogin(identity);
    } catch (err) {
      setErrorText(err.message || "Login failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTempAccess(role) {
    setTempLoading(role);
    setErrorText("");
    try {
      const identity = await startTempSession(role);
      onLogin(identity);
    } catch (err) {
      setErrorText(err.message || "Couldn't start a session. Please try again.");
    } finally {
      setTempLoading(null);
    }
  }

  return (
    <main className="login-main">
      <div className="login-card">
        <h1>TYK</h1>
        <p className="login-subtitle">Tykel Intelligence</p>

        {errorText && <div className="inline-error">{errorText}</div>}

        <form className="login-form" onSubmit={handleLogin}>
          <label className="login-label">Select your name</label>
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            disabled={users.length === 0}
          >
            {users.length === 0 && <option>No accounts yet</option>}
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>

          <label className="login-label">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />

          <button type="submit" disabled={!selectedUserId || !password || submitting}>
            {submitting ? "Logging in…" : "Login"}
          </button>
        </form>

        <div className="login-divider">Temporary access</div>

        <div className="login-temp-row">
          <button
            type="button"
            className="login-temp-button"
            onClick={() => handleTempAccess("installer")}
            disabled={tempLoading !== null}
          >
            {tempLoading === "installer" ? "…" : "Installer"}
          </button>
          <button
            type="button"
            className="login-temp-button"
            onClick={() => handleTempAccess("other")}
            disabled={tempLoading !== null}
          >
            {tempLoading === "other" ? "…" : "Other"}
          </button>
        </div>
        <p className="login-temp-note">No name. No password. Nothing is kept after you sign out.</p>
      </div>
    </main>
  );
}

export default LoginScreen;
