import { supabase } from "./supabase";

const STORAGE_KEY = "tyk_identity";

async function invokeAuth(payload) {
  const { data, error } = await supabase.functions.invoke("auth-users", {
    body: payload,
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

// Persistent users (Admin/Office) survive a page reload; temporary sessions
// (Installer/Other) also survive a reload of the SAME tab (so refreshing
// doesn't accidentally strand the user), but are deleted server-side the
// moment they explicitly sign out.
export function loadStoredIdentity() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const identity = JSON.parse(raw);
    // An identity saved before signed sessions existed has no token - treat
    // it as already signed out rather than returning it for one render tick.
    if (!identity?.token) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

export function storeIdentity(identity) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

export function clearStoredIdentity() {
  sessionStorage.removeItem(STORAGE_KEY);
}

export async function listLoginUsers() {
  const { users } = await invokeAuth({ action: "list-login-users" });
  return users || [];
}

export async function login(userId, password) {
  const { identity } = await invokeAuth({
    action: "login",
    user_id: userId,
    password,
  });
  storeIdentity(identity);
  return identity;
}

export async function startTempSession(role) {
  const { identity } = await invokeAuth({ action: "start-temp-session", role });
  storeIdentity(identity);
  return identity;
}

export async function endTempSession(identity) {
  await invokeAuth({ action: "end-temp-session", session_id: identity.id, token: identity.token });
  clearStoredIdentity();
}

export function signOut(identity) {
  if (identity?.type === "session") {
    return endTempSession(identity);
  }
  clearStoredIdentity();
  return Promise.resolve();
}

// ---- Admin Users page (persistent users only) ----

export async function listUsers(identity) {
  const { users } = await invokeAuth({
    action: "list-users",
    token: identity?.token,
  });
  return users || [];
}

export async function createUser(identity, { name, role, password }) {
  const { user } = await invokeAuth({
    action: "create-user",
    token: identity?.token,
    name,
    role,
    password,
  });
  return user;
}

export async function updateUser(identity, userId, updates) {
  const { user } = await invokeAuth({
    action: "update-user",
    token: identity?.token,
    user_id: userId,
    ...updates,
  });
  return user;
}

export async function resetPassword(identity, userId, password) {
  await invokeAuth({
    action: "reset-password",
    token: identity?.token,
    user_id: userId,
    password,
  });
}

export async function deleteUser(identity, userId) {
  const { data, error } = await supabase.functions.invoke("auth-users", {
    body: { action: "delete-user", user_id: userId, token: identity?.token },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listRoleDefaults(identity) {
  const { defaults } = await invokeAuth({
    action: "list-role-defaults",
    token: identity?.token,
  });
  return defaults || [];
}

export async function updateRoleDefaults(identity, role, permissions) {
  const { defaults } = await invokeAuth({
    action: "update-role-defaults",
    token: identity?.token,
    role,
    permissions,
  });
  return defaults;
}
