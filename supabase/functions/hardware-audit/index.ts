import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { hasPermission } from "../_shared/permissions.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function parseSchedule(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const openings = lines.filter((line) => /\b(?:opening|door|op|opening no|opening #)\b\s*[-#: ]?\w+/i.test(line));
  const setMatches = [...text.matchAll(/\b(?:hardware\s*set|set)\s*[-#: ]?([A-Z0-9-]+)/gi)];
  const quantities = [...text.matchAll(/\b(\d+)\s+(hinge|closer|lock|latch|flush bolt|exit device|strike|cylinder|threshold)/gi)]
    .map((match) => ({ quantity: Number(match[1]), item: match[2].toLowerCase() }));
  const ratings = [...new Set((text.match(/\b(?:20|45|60|90|180)\s*minute\b|\b(?:20|45|60|90|180)-?min\b/gi) || []))];
  const manufacturers = [...new Set((text.match(/\b(?:Von Duprin|LCN|Allegion|Hager|ASSA ABLOY|dormakaba|Sargent|Schlage|Ives|Rockwood)\b/gi) || []))];
  const finishes = [...new Set((text.match(/\b(?:US3|US4|US10|US26|US28|US32|US32D|black|grey|gray|bronze|stainless)\b/gi) || []))];
  const sets = [...new Set(setMatches.map((match) => match[1]))];
  return { lines, openings, sets, quantities, ratings, manufacturers, finishes };
}

async function loadAuditText(documentId) {
  const { data: chunks, error } = await supabase
    .from("document_chunks")
    .select("id, page_number, chunk_index, content")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true });
  if (error) throw error;
  return (chunks || []).map((chunk) => `[Page ${chunk.page_number || "?"}] ${chunk.content}`).join("\n"), chunks || [];
}

async function buildFindings(parsed, documentId) {
  const findings = [];
  const evidence = { document_id: documentId, ratings: parsed.ratings, manufacturers: parsed.manufacturers };
  if (parsed.ratings.length) {
    findings.push({
      severity: "HIGH",
      category: "COMPLIANCE / CODE",
      title: "Fire-rated opening requires evidence review",
      description: `The schedule contains fire rating references (${parsed.ratings.join(", ")}). Verify the door, frame, label, self-closing, latching, and hardware assembly against the applicable jurisdiction and listing.`,
      recommendation: "Confirm the applicable code edition and listed/labeled assembly before ordering.",
      evidence: { ...evidence, state: "NEEDS_REVIEW" },
    });
  }
  if (parsed.finishes.length > 1) {
    findings.push({
      severity: "MEDIUM",
      category: "SCHEDULE INCONSISTENCY",
      title: "Multiple hardware finishes detected",
      description: `The schedule contains multiple finish values: ${parsed.finishes.join(", ")}. This may be intentional, but comparable openings should be checked.`,
      recommendation: "Verify finish consistency against the project finish schedule.",
      evidence: { ...evidence, finishes: parsed.finishes, state: "POSSIBLE" },
    });
  }
  const quantityByItem = {};
  for (const item of parsed.quantities) quantityByItem[item.item] = (quantityByItem[item.item] || 0) + item.quantity;
  if (quantityByItem.hinge === 1) {
    findings.push({
      severity: "MEDIUM",
      category: "UNUSUAL / VERIFY",
      title: "Single hinge quantity detected",
      description: "A schedule line contains one hinge. This is unusual for many commercial door configurations and may be a quantity or extraction issue.",
      recommendation: "Verify the opening configuration and hinge quantity against the manufacturer and project requirements.",
      evidence: { ...evidence, quantity: 1, item: "hinge", state: "POSSIBLE" },
    });
  }
  for (const manufacturer of parsed.manufacturers) {
    if (/von duprin|lcn|allegion|hager|sargent|schlage|dormakaba/i.test(manufacturer)) {
      await supabase.from("research_queue").upsert({
        topic: `Research ${manufacturer} hardware schedule products`,
        title: `Research ${manufacturer} hardware schedule products`,
        description: `Identify manufacturer products, compatibility, and installation requirements found in a hardware schedule audit.`,
        type: "RESEARCH",
        entity_name: manufacturer,
        priority: 7,
        source_type: "manufacturer",
        search_queries: [`${manufacturer} hardware schedule products`, `${manufacturer} official installation documentation`],
        reason: "Unknown or partially verified manufacturer information was found during a schedule audit.",
        status: "queued",
      }, { onConflict: "topic,entity_id", ignoreDuplicates: true });
    }
  }
  return findings;
}

async function runAudit(auditId, documentId) {
  const [text, chunks] = await loadAuditText(documentId);
  const parsed = parseSchedule(text);
  const findings = await buildFindings(parsed, documentId);
  if (findings.length) await supabase.from("hardware_audit_findings").insert(findings.map((finding) => ({ audit_id: auditId, ...finding })));
  await supabase.from("hardware_audits").update({
    status: "complete",
    openings_count: parsed.openings.length,
    hardware_sets_count: parsed.sets.length,
    issues_count: findings.length,
    summary: { ...parsed, chunks: chunks.length, stages: ["EXTRACTED", "STRUCTURED", "CODE_CHECKED", "PATTERN_CHECKED", "RESEARCH_TASKS_CREATED"] },
    updated_at: new Date().toISOString(),
  }).eq("id", auditId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    if (!(await hasPermission(body, "can_upload_documents"))) return json({ error: "Forbidden" }, 403);

    if (body.action === "list") {
      const { data, error } = await supabase.from("hardware_audits").select("*").order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ audits: data || [] });
    }

    if (body.action === "create") {
      if (!body.document_id) return json({ error: "document_id is required" }, 400);
      const { data: audit, error } = await supabase.from("hardware_audits").insert({ document_id: body.document_id, project_name: body.project_name || "Untitled hardware schedule" }).select().single();
      if (error) return json({ error: error.message }, 500);
      try { await runAudit(audit.id, body.document_id); } catch {
        await supabase.from("hardware_audits").update({ status: "error", summary: { error: "Audit extraction failed." } }).eq("id", audit.id);
      }
      return json({ audit: (await supabase.from("hardware_audits").select("*").eq("id", audit.id).single()).data });
    }

    if (body.action === "get") {
      const { data: audit, error } = await supabase.from("hardware_audits").select("*").eq("id", body.audit_id).single();
      if (error) return json({ error: "Audit not found" }, 404);
      const { data: findings } = await supabase.from("hardware_audit_findings").select("*").eq("audit_id", body.audit_id).order("severity");
      return json({ audit, findings: findings || [] });
    }

    if (body.action === "review") {
      const { error } = await supabase.from("hardware_audit_findings").update({ status: body.status, resolved_at: body.status === "RESOLVED" ? new Date().toISOString() : null }).eq("id", body.finding_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("hardware-audit error:", error);
    return json({ error: "Hardware audit failed." }, 500);
  }
});
