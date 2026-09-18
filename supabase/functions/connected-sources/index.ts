// Management API for Connected Sources (list + trigger a connection check).
// Real per-question usage happens inside ask-tyk via getActiveConnector();
// this function is only for the Settings UI.
import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { refreshConnectedSourceStatus } from "../_shared/connected-sources/registry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "list") {
      const { data, error } = await supabase
        .from("connected_sources")
        .select(
          "id, name, provider, status, authentication_status, capabilities, source_url, last_checked, last_error",
        )
        .order("name", { ascending: true });

      if (error) return json({ error: error.message }, 500);
      return json({ sources: data || [] });
    }

    if (action === "check") {
      const { provider } = body;
      if (!provider) return json({ error: "provider is required" }, 400);

      const source = await refreshConnectedSourceStatus(provider);
      if (!source) return json({ error: `Unknown provider: ${provider}` }, 404);
      return json({ source });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("connected-sources error:", err);
    return json({ error: "Something went wrong." }, 500);
  }
});
