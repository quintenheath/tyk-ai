// Identity system: two distinct classes of access.
//
// PERSISTENT users (admin/office) - named, password-protected, permanent
// user_id, permanent conversations/context. Managed on the admin Users page.
//
// TEMPORARY sessions (installer/other) - anonymous, no password, no name.
// A temp_sessions row exists only for the duration of a session; ending the
// session deletes its conversations/messages entirely. Nothing here ever
// creates a persistent identity for a temporary user.
import bcrypt from "npm:bcryptjs@2.4.3";
import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { signToken } from "../_shared/session.ts";
import { loadIdentity } from "../_shared/permissions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const PERSISTENT_ROLES = ["admin", "office"];
const TEMP_ROLES = ["installer", "other"];

function isQuintenUser(userId) {
  const authorizedId = Deno.env.get("QUINTEN_USER_ID");
  return Boolean(authorizedId && userId === authorizedId);
}

// Default permission sets used only as a fallback if role_permission_defaults
// (admin-editable via get/update-role-defaults below) has no row for a role
// yet - keeps the app working even before that table is ever touched.
const DEFAULT_PERMISSIONS = {
  admin: {
    can_teach_tyk: true,
    can_approve_company_knowledge: true,
    can_upload_documents: true,
    can_manage_documents: true,
    can_manage_users: true,
    can_view_settings: true,
    can_view_research: true,
  },
  office: {
    can_teach_tyk: true,
    can_approve_company_knowledge: true,
    can_upload_documents: true,
    can_manage_documents: false,
    can_manage_users: false,
    can_view_settings: true,
    can_view_research: false,
  },
  installer: {
    can_teach_tyk: true,
    can_approve_company_knowledge: false,
    can_upload_documents: true,
    can_manage_documents: false,
    can_manage_users: false,
    can_view_settings: false,
    can_view_research: false,
  },
  other: {
    can_teach_tyk: false,
    can_approve_company_knowledge: false,
    can_upload_documents: false,
    can_manage_documents: false,
    can_manage_users: false,
    can_view_settings: false,
    can_view_research: false,
  },
};


function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function roleDefaults(role) {
  const { data } = await supabase
    .from("role_permission_defaults")
    .select("permissions")
    .eq("role", role)
    .maybeSingle();
  return data?.permissions || DEFAULT_PERMISSIONS[role];
}

// Every admin-only action re-verifies a SIGNED token (see _shared/session.ts)
// rather than trusting a client-supplied user_id - a bare id could otherwise
// be reused by anyone who obtained/guessed it to impersonate an admin.
async function requireAdmin(body) {
  const identity = await loadIdentity(body);
  return Boolean(identity && identity.type === "user" && identity.role === "admin");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    // ---- Login screen: names for the dropdown, no passwords/permissions ----
    if (action === "list-login-users") {
      const { data, error } = await supabase
        .from("app_users")
        .select("id, name, role")
        .eq("disabled", false)
        .order("name", { ascending: true });

      if (error) return json({ error: error.message }, 500);
      return json({ users: data || [] });
    }

    if (action === "login") {
      const { user_id, password } = body;
      if (!user_id || !password) {
        return json({ error: "user_id and password are required" }, 400);
      }

      const { data: user, error } = await supabase
        .from("app_users")
        .select("id, name, role, password_hash, permissions, disabled")
        .eq("id", user_id)
        .maybeSingle();

      if (error) return json({ error: error.message }, 500);
      if (!user || user.disabled) {
        return json({ error: "Invalid name or password" }, 401);
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return json({ error: "Invalid name or password" }, 401);

      const token = await signToken("user", user.id);
      return json({
        identity: {
          type: "user",
          id: user.id,
          name: user.name,
          role: user.role,
          permissions: user.permissions,
          isQuinten: isQuintenUser(user.id),
          token,
        },
      });
    }

    // ---- Temporary access: no name, no password, deleted on sign-out ----
    if (action === "start-temp-session") {
      const { role } = body;
      if (!TEMP_ROLES.includes(role)) {
        return json({ error: "role must be installer or other" }, 400);
      }

      const { data, error } = await supabase
        .from("temp_sessions")
        .insert({ role, permissions: await roleDefaults(role) })
        .select()
        .single();

      if (error) return json({ error: error.message }, 500);
      const token = await signToken("session", data.id);
      return json({
        identity: {
          type: "session",
          id: data.id,
          role: data.role,
          permissions: data.permissions,
          token,
        },
      });
    }

    if (action === "end-temp-session") {
      const { session_id } = body;
      if (!session_id) return json({ error: "session_id is required" }, 400);

      // Anyone can ask to end a session, but only its OWN valid token may -
      // otherwise a guessed session_id could delete someone else's session.
      const identity = await loadIdentity(body);
      if (!identity || identity.type !== "session" || identity.id !== session_id) {
        return json({ error: "Forbidden" }, 403);
      }

      // Deleting the session cascades to its conversations, which cascades to
      // their messages - a temporary user's activity leaves nothing behind.
      const { error } = await supabase
        .from("temp_sessions")
        .delete()
        .eq("id", session_id);

      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ---- Admin Users page: persistent users only ----
    if (action === "list-users") {
      if (!(await requireAdmin(body))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { data, error } = await supabase
        .from("app_users")
        .select("id, name, role, permissions, disabled, created_at, updated_at")
        .order("created_at", { ascending: true });

      if (error) return json({ error: error.message }, 500);
      return json({ users: data || [] });
    }

    if (action === "create-user") {
      // Bootstrap exception: the very first persistent user can be created
      // with no acting admin, since no admin can possibly exist yet. Once at
      // least one app_users row exists, every create-user call is locked down
      // to real admins again.
      const { count } = await supabase
        .from("app_users")
        .select("id", { count: "exact", head: true });
      const isBootstrap = (count || 0) === 0;

      if (!isBootstrap && !(await requireAdmin(body))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { name, password } = body;
      const role = isBootstrap ? "admin" : body.role;
      if (!name?.trim() || !PERSISTENT_ROLES.includes(role) || !password) {
        return json(
          { error: "name, role (admin/office), and password are required" },
          400,
        );
      }

      const password_hash = await bcrypt.hash(password, 10);
      const { data, error } = await supabase
        .from("app_users")
        .insert({
          name: name.trim(),
          role,
          password_hash,
          permissions: await roleDefaults(role),
        })
        .select("id, name, role, permissions, disabled, created_at, updated_at")
        .single();

      if (error) return json({ error: error.message }, 500);
      return json({ user: data });
    }

    if (action === "update-user") {
      if (!(await requireAdmin(body))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { user_id, name, role, permissions, disabled } = body;
      if (!user_id) return json({ error: "user_id is required" }, 400);

      const { data: target } = await supabase.from("app_users").select("id, role, disabled").eq("id", user_id).maybeSingle();
      if (!target) return json({ error: "User not found" }, 404);
      if (target.role === "admin" && (role === "office" || disabled === true)) {
        const { count: adminCount } = await supabase.from("app_users").select("id", { count: "exact", head: true }).eq("role", "admin").eq("disabled", false);
        if ((adminCount || 0) <= 1) return json({ error: "The last active admin cannot be disabled or demoted." }, 409);
      }

      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (name?.trim()) updates.name = name.trim();
      if (role) {
        if (!PERSISTENT_ROLES.includes(role)) {
          return json({ error: "role must be admin or office" }, 400);
        }
        updates.role = role;
      }
      if (permissions) updates.permissions = permissions;
      if (typeof disabled === "boolean") updates.disabled = disabled;

      const { data, error } = await supabase
        .from("app_users")
        .update(updates)
        .eq("id", user_id)
        .select("id, name, role, permissions, disabled, created_at, updated_at")
        .single();

      if (error) return json({ error: error.message }, 500);
      return json({ user: data });
    }

    if (action === "delete-user") {
      if (!(await requireAdmin(body))) return json({ error: "Forbidden" }, 403);
      const { user_id } = body;
      if (!user_id) return json({ error: "user_id is required" }, 400);
      const { data: target } = await supabase.from("app_users").select("id, role, disabled").eq("id", user_id).maybeSingle();
      if (!target) return json({ error: "User not found" }, 404);
      if (target.role === "admin") {
        const { count: adminCount } = await supabase.from("app_users").select("id", { count: "exact", head: true }).eq("role", "admin").eq("disabled", false);
        if ((adminCount || 0) <= 1) return json({ error: "The last active admin cannot be deleted." }, 409);
      }
      const { error } = await supabase.from("app_users").delete().eq("id", user_id);
      if (error) return json({ error: "Could not delete user." }, 500);
      return json({ ok: true });
    }

    if (action === "reset-password") {
      if (!(await requireAdmin(body))) {
        return json({ error: "Forbidden" }, 403);
      }

      const { user_id, password } = body;
      if (!user_id || !password) {
        return json({ error: "user_id and password are required" }, 400);
      }

      const password_hash = await bcrypt.hash(password, 10);
      const { error } = await supabase
        .from("app_users")
        .update({ password_hash, updated_at: new Date().toISOString() })
        .eq("id", user_id);

      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // Lets an admin see/adjust what Installer/Other (and new Admin/Office
    // accounts) start with, without a code change - covers "role-based
    // default permissions... design so it can be adjusted" from the spec.
    if (action === "list-role-defaults") {
      if (!(await requireAdmin(body))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { data, error } = await supabase
        .from("role_permission_defaults")
        .select("role, permissions, updated_at")
        .order("role", { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ defaults: data || [] });
    }

    if (action === "update-role-defaults") {
      if (!(await requireAdmin(body))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { role, permissions } = body;
      if (!role || !permissions) {
        return json({ error: "role and permissions are required" }, 400);
      }
      const { data, error } = await supabase
        .from("role_permission_defaults")
        .upsert({ role, permissions, updated_at: new Date().toISOString() })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ defaults: data });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
