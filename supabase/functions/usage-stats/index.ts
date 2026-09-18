// Read-only telemetry dashboard for the low-AI architecture: how many
// questions were answered without any AI call, and where the rest came from.
import { supabaseAdmin } from "../_shared/supabase-admin.ts";

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
    const { data: rows, error } = await supabaseAdmin
      .from("ai_usage")
      .select("source_used, ai_required, provider, latency_ms, created_at")
      .order("created_at", { ascending: false })
      .limit(1000);

    if (error) return json({ error: error.message }, 500);

    const total = rows.length;
    const zeroAiCount = rows.filter((r) => !r.ai_required).length;
    const aiCount = total - zeroAiCount;
    const failedCount = rows.filter(
      (r) => r.source_used === "ai_reasoning_failed",
    ).length;

    const bySource = {};
    for (const row of rows) {
      bySource[row.source_used] = (bySource[row.source_used] || 0) + 1;
    }

    const latencies = rows.map((r) => r.latency_ms).filter((v) => v != null);
    const avgLatencyMs = latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : null;

    return json({
      total,
      zeroAiCount,
      aiCount,
      failedCount,
      zeroAiPercent: total ? Math.round((zeroAiCount / total) * 100) : 0,
      avgLatencyMs,
      bySource,
    });
  } catch (err) {
    console.error("usage-stats error:", err);
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
