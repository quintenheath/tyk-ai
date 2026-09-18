// Server-side permission lookup. Callers pass a signed session token (issued
// by auth-users at login/start-temp-session) - never a bare user_id/
// session_id, which anyone who obtained/guessed a UUID could otherwise use to
// impersonate that identity. The token is verified (signature + expiry) here
// and permissions are always read fresh from the DB, never trusted from the
// client payload - this is what makes "server-side permissions are
// authoritative" actually true rather than just a comment.
import { supabaseAdmin } from "./supabase-admin.ts";
import { verifyToken } from "./session.ts";

export async function loadIdentity(body: Record<string, unknown>) {
  const payload = await verifyToken(body.token);
  if (!payload) return null;

  if (payload.type === "user") {
    const { data } = await supabaseAdmin
      .from("app_users")
      .select("id, role, permissions, disabled")
      .eq("id", payload.id)
      .maybeSingle();
    if (!data || data.disabled) return null;
    return { type: "user", id: data.id, role: data.role, permissions: data.permissions || {} };
  }

  const { data } = await supabaseAdmin
    .from("temp_sessions")
    .select("id, role, permissions")
    .eq("id", payload.id)
    .maybeSingle();
  if (!data) return null;
  return { type: "session", id: data.id, role: data.role, permissions: data.permissions || {} };
}

export async function hasPermission(
  body: Record<string, unknown>,
  permissionKey: string,
) {
  const identity = await loadIdentity(body);
  if (!identity) return false;
  if (identity.type === "user" && identity.role === "admin") return true;
  return identity.permissions?.[permissionKey] === true;
}
