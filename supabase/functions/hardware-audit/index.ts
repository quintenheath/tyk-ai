import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { hasPermission, loadIdentity } from "../_shared/permissions.ts";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function createReportPdf(audit, findings) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let y = page.getHeight() - 48;
  const draw = (text, size = 11, color = rgb(0.12, 0.14, 0.16)) => {
    page.drawText(String(text).slice(0, 110), { x: 42, y, size, font, color });
    y -= size + 8;
    if (y < 48) { y = page.getHeight() - 48; pdf.addPage(); }
  };
  draw("TYK Hardware Schedule Audit", 18);
  draw(`Project: ${audit.project_name || "Untitled"}`);
  draw(`Generated: ${new Date().toISOString()}`);
  draw(`Openings: ${audit.openings_count} | Hardware sets: ${audit.hardware_sets_count} | Findings: ${audit.issues_count}`);
  y -= 8;
  for (const finding of findings) {
    draw(`${finding.severity} — ${finding.title}`, 12, rgb(0.75, 0.18, 0.12));
    draw(finding.category);
    draw(finding.description);
    if (finding.recommendation) draw(`Recommendation: ${finding.recommendation}`);
    draw(`Evidence state: ${finding.evidence?.state || "NEEDS_REVIEW"}`);
    y -= 8;
  }
  return pdf.save();
}

async function createReviewedPdf(audit, findings, originalBytes) {
  const pdf = await PDFDocument.load(originalBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage();
  let y = page.getHeight() - 48;
  const draw = (text, size = 10) => {
    if (y < 48) { page = pdf.addPage(); y = page.getHeight() - 48; }
    page.drawText(String(text).slice(0, 120), { x: 42, y, size, font });
    y -= size + 8;
  };
  draw("TYK Reviewed Hardware Schedule", 18);
  draw(`Project: ${audit.project_name || "Untitled"}`);
  draw("Original schedule pages are preserved unchanged.");
  draw("Legend: PENDING REVIEW = yellow | MANUFACTURER/PRODUCT = orange | CODE/COMPLIANCE = red | INFORMATIONAL = blue");
  y -= 8;
  for (const finding of findings) {
    const state = finding.status || "NEEDS_REVIEW";
    draw(`${state} | ${finding.severity} | ${finding.category} | ${finding.title}`, 11);
    draw(`Evidence: ${finding.description}`);
    if (finding.recommendation) draw(`Recommendation: ${finding.recommendation}`);
    draw(`Page: ${finding.evidence?.page || "?"} | Opening: ${finding.evidence?.opening || "?"}`);
    y -= 8;
  }
  return pdf.save();
}

function parseSchedule(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pageForLine = (line) => Number(line.match(/^\[Page\s+(\d+)\]/i)?.[1] || 1);
  const cleanLine = (line) => line.replace(/^\[Page\s+\d+\]\s*/i, "").trim();
  const compactText = text.replace(/\s+/g, "");
  const pageAt = (index) => {
    const marker = text.slice(0, index).match(/\[Page\s+(\d+)\]/gi);
    return Number(marker?.at(-1)?.match(/\d+/)?.[0] || 1);
  };
  const openingPattern = /^(D\d+[A-Z-]*)\b\s*(.*)$/i;
  const openingMatches = [
    ...text.matchAll(/\b(D\s*\d+)\s+S\s*i\s*n\s*g\s*l\s*e\s+D\s*o\s*o\s*r\b([\s\S]*?)(?=\bD\s*\d+\s+S\s*i\s*n\s*g\s*l\s*e\s+D\s*o\s*o\s*r\b|$)/gi),
  ];
  const openings = openingMatches.map((match) => ({
    id: match[1].replace(/\s+/g, "").toUpperCase(),
    description: `Single Door${match[2].replace(/\s+/g, " ").trim().slice(0, 180)}`,
    page: pageAt(match.index),
  }));
  lines.forEach((line) => {
    const clean = cleanLine(line);
    const match = clean.match(openingPattern) || clean.match(/\b(opening\s*#?\s*[A-Z0-9-]+)\b\s*(.*)$/i);
    if (match) openings.push({ id: match[1].replace(/\s+/g, "").toUpperCase(), description: (match[2] || clean).trim(), page: pageForLine(line) });
  });
  const setMatches = [
    ...text.matchAll(/\b(?:hardware\s*(?:set|group)|hw\s*set)\s*[-#: ]?(\d+)\b/gi),
    ...compactText.matchAll(/Heading#(\d+)/gi),
  ];
  const quantities = [...text.matchAll(/\b(\d+)\s+(hinge|closer|lock|latch|flush bolt|exit device|strike|cylinder|threshold|kick plate|seal|sweep|lever|deadbolt)/gi)]
    .map((match) => ({ quantity: Number(match[1]), item: match[2].toLowerCase() }));
  const ratings = [...new Set((text.match(/\b(?:20|45|60|90|180)\s*minute\b|\b(?:20|45|60|90|180)-?min\b/gi) || []))];
  const manufacturers = [...new Set((text.match(/\b(?:Von Duprin|LCN|Allegion|Hager|ASSA ABLOY|dormakaba|Sargent|Schlage|Ives|Rockwood)\b/gi) || []))];
  const finishes = [...new Set((text.match(/\b(?:US3|US4|US10|US26|US28|US32|US32D|black|grey|gray|bronze|stainless)\b/gi) || []))];
  const sets = [...new Set(setMatches.map((match) => match[1]))];
  const productMatches = [
    ...compactText.matchAll(/\b(?:BB\d+[A-Z]*|DS\d+[A-Z0-9]*|FH\d+[A-Z0-9]*|TLA\d+[A-Z0-9]*|ARM\d+[A-Z0-9]*|K\d+[A-Z0-9]*|\d{3,5}[A-Z]{1,6}\d*)\b/gi),
  ];
  const hardwareItems = [...new Map(productMatches.map((match) => [match[0].toUpperCase(), { page: pageAt(match.index), text: match[0].toUpperCase(), products: [match[0].toUpperCase()] }])).values()];
  const openingConfigurations = [...new Set(openings.map((opening) => {
    const hand = opening.description.match(/\b(L\s*H\s*R|R\s*H\s*R)\b/i)?.[1]?.replace(/\s+/g, "").toUpperCase();
    return hand || opening.description.replace(/D\d+/i, "").slice(0, 80);
  }))];
  const handingConfigurations = [...new Set(openings
    .map((opening) => opening.description.match(/\b(L\s*H\s*R|R\s*H\s*R)\b/i)?.[1]?.replace(/\s+/g, "").toUpperCase())
    .filter(Boolean))];
  const explicitSets = [...new Set(sets.map((match) => match[1]))];
  const derivedSets = handingConfigurations.length > 1
    ? handingConfigurations.map((configuration) => `HAND-${configuration}`)
    : openingConfigurations.length > 1
      ? openingConfigurations.map((configuration) => `CONFIG-${configuration}`)
    : explicitSets.length
      ? explicitSets
      : [...new Set(hardwareItems.map((item) => item.page))].map((page) => `PAGE-${page}`);
  return { lines, openings: [...new Map(openings.map((opening) => [opening.id, opening])).values()], sets: derivedSets, quantities, ratings, manufacturers, finishes, hardwareItems };
}

async function loadAuditText(documentId) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const { data: document } = await supabase.from("documents").select("status, error_message").eq("id", documentId).maybeSingle();
    if (document?.status === "error") throw new Error("The schedule could not be extracted.");
    const { data: chunks, error } = await supabase
      .from("document_chunks")
      .select("id, page_number, chunk_index, content")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true });
    if (error) throw error;
    if (chunks?.length) return [(chunks || []).map((chunk) => `[Page ${chunk.page_number || "?"}] ${chunk.content}`).join("\n"), chunks || []];
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("The schedule text is not ready yet.");
}

async function appendAuditMessage(conversationId, content, metadata) {
  if (!conversationId) return;
  await supabase.from("messages").insert({ conversation_id: conversationId, role: "assistant", content, metadata: { audit: true, ...metadata } });
}

async function linkAuditDocument(auditId, documentId, conversationId) {
  const [{ error: documentError }, { error: chunkError }, { error: conversationError }] = await Promise.all([
    supabase.from("documents").update({ document_scope: "AUDIT_ONLY", audit_id: auditId, conversation_id: conversationId }).eq("id", documentId),
    supabase.from("document_chunks").update({ document_scope: "AUDIT_ONLY", audit_id: auditId, conversation_id: conversationId }).eq("document_id", documentId),
    supabase.from("conversations").update({ active_audit: auditId, active_document: documentId }).eq("id", conversationId),
  ]);
  if (documentError || chunkError || conversationError) throw new Error("Could not preserve the audit document relationship.");
}

async function buildFindings(parsed, documentId) {
  const findings = [];
  const evidence = {
    document_id: documentId,
    page: parsed.openings[0]?.page || parsed.hardwareItems[0]?.page || null,
    opening: parsed.openings[0]?.id || null,
    hardware_item: parsed.hardwareItems[0]?.text || null,
    ratings: parsed.ratings,
    manufacturers: parsed.manufacturers,
  };
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
  const { data: audit } = await supabase.from("hardware_audits").select("conversation_id, project_name").eq("id", auditId).single();
  await linkAuditDocument(auditId, documentId, audit?.conversation_id || null);
  await appendAuditMessage(audit?.conversation_id, "I'm reviewing the hardware schedule now.", { auditId, auditStatus: "analyzing", auditStage: "Extracting schedule" });
  const [text, chunks] = await loadAuditText(documentId);
  await appendAuditMessage(audit?.conversation_id, "The schedule is readable. I’m extracting openings and hardware items.", { auditId, auditStatus: "analyzing", auditStage: "Extracting openings and hardware" });
  const parsed = parseSchedule(text);
  await appendAuditMessage(audit?.conversation_id, `Found ${parsed.openings.length} openings and ${parsed.sets.length} hardware sets. I’m checking the schedule for items that need review.`, { auditId, auditStatus: "analyzing", auditStage: "Checking requirements", openings: parsed.openings.length, hardwareSets: parsed.sets.length });
  const findings = await buildFindings(parsed, documentId);
  let savedFindings = [];
  if (findings.length) {
    const result = await supabase.from("hardware_audit_findings").insert(findings.map((finding) => ({ audit_id: auditId, ...finding }))).select();
    savedFindings = result.data || [];
  }
  const fireFindings = savedFindings.filter((finding) => /COMPLIANCE|CODE|FIRE/i.test(finding.category) || /fire/i.test(finding.title));
  const colourFinding = savedFindings.find((finding) => /finish/i.test(finding.title));
  const auditChecks = {
    fire: { status: fireFindings.length ? "ISSUES FOUND" : parsed.ratings.length ? "NEEDS REVIEW" : "PASSED", findingIds: fireFindings.map((finding) => finding.id) },
    suggestions: { status: "COMPLETE", count: savedFindings.length },
    colour: { status: colourFinding ? "ISSUES FOUND" : parsed.finishes.length ? "PASSED" : "NEEDS REVIEW", findingIds: colourFinding ? [colourFinding.id] : [] },
  };
  const itemSummary = parsed.hardwareItems.slice(0, 20).map((item) => `Page ${item.page}: ${item.text}`).join("\n");
  await appendAuditMessage(audit?.conversation_id, `Here’s what I found${audit?.project_name ? ` for ${audit.project_name}` : ""}.\n\nOpenings: ${parsed.openings.map((opening) => `${opening.id} (page ${opening.page})`).join(", ") || "None identified"}\n\nHardware items:\n${itemSummary || "No product lines were identified."}\n\n${savedFindings.length ? `I found ${savedFindings.length} item${savedFindings.length === 1 ? "" : "s"} to review below.` : "I did not find an issue requiring review in the extracted text."}`, { auditId, auditStatus: "complete", auditStage: "Audit complete", auditChecks, auditFindings: savedFindings, documentId, citations: chunks.map((chunk) => ({ documentId, page: chunk.page_number })) });
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
      const identity = await loadIdentity(body);
      if (!identity) return json({ error: "A valid session token is required" }, 401);
      const ownerColumnName = identity.type === "user" ? "user_id" : "session_id";
      const { data, error } = await supabase.from("hardware_audits").select("*").eq(ownerColumnName, identity.id).order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ audits: data || [] });
    }

    if (body.action === "create") {
      if (!body.document_id) return json({ error: "document_id is required" }, 400);
      const identity = await loadIdentity(body);
      if (!identity) return json({ error: "A valid session token is required" }, 401);
      const owner = identity.type === "user" ? { user_id: identity.id } : { session_id: identity.id };
      const projectName = body.project_name || "Untitled hardware schedule";
      const { data: conversation, error: conversationError } = await supabase.from("conversations").insert({ title: `Hardware Schedule Audit — ${projectName}`, topic_summary: `Hardware schedule audit for ${projectName}.`, ...owner }).select().single();
      if (conversationError) return json({ error: "Could not start the audit conversation." }, 500);
      await supabase.from("messages").insert({ conversation_id: conversation.id, role: "user", content: `Hardware Schedule Audit: ${projectName}`, metadata: { audit: true, attachments: [body.document_name || projectName] } });
      const { data: audit, error } = await supabase.from("hardware_audits").insert({ document_id: body.document_id, conversation_id: conversation.id, project_name: projectName, ...owner }).select().single();
      if (error) return json({ error: error.message }, 500);
      await linkAuditDocument(audit.id, body.document_id, conversation.id);
      await appendAuditMessage(conversation.id, "The hardware schedule is attached to this audit. I’m starting the document analysis now.", { auditId: audit.id, auditStatus: "analyzing", auditStage: "Queued for extraction", documentId: body.document_id });
      const work = runAudit(audit.id, body.document_id).catch(async () => {
        await supabase.from("hardware_audits").update({ status: "error", summary: { error: "Audit extraction failed." } }).eq("id", audit.id);
        await appendAuditMessage(conversation.id, "I can access the original hardware schedule, but I couldn’t extract the schedule reliably. The audit and document are still attached; try OCR analysis or open the document to review the pages.", { auditId: audit.id, auditStatus: "error", auditStage: "Extraction failed", documentId: body.document_id });
      });
      if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work);
      else await work;
      return json({ audit, conversation });
    }

    if (body.action === "get") {
      const identity = await loadIdentity(body);
      if (!identity) return json({ error: "A valid session token is required" }, 401);
      const ownerColumnName = identity.type === "user" ? "user_id" : "session_id";
      const { data: audit, error } = await supabase.from("hardware_audits").select("*").eq("id", body.audit_id).eq(ownerColumnName, identity.id).single();
      if (error) return json({ error: "Audit not found" }, 404);
      const { data: findings } = await supabase.from("hardware_audit_findings").select("*").eq("audit_id", body.audit_id).order("severity");
      return json({ audit, findings: findings || [] });
    }

    if (body.action === "review") {
      const identity = await loadIdentity(body);
      if (!identity) return json({ error: "A valid session token is required" }, 401);
      const ownerColumnName = identity.type === "user" ? "user_id" : "session_id";
      const { data: finding } = await supabase.from("hardware_audit_findings").select("audit_id").eq("id", body.finding_id).maybeSingle();
      const { data: audit } = await supabase.from("hardware_audits").select("id").eq("id", finding?.audit_id).eq(ownerColumnName, identity.id).maybeSingle();
      if (!audit) return json({ error: "Finding not found" }, 404);
      const { error } = await supabase.from("hardware_audit_findings").update({ status: body.status, resolved_at: body.status === "RESOLVED" ? new Date().toISOString() : null }).eq("id", body.finding_id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (body.action === "export-report") {
      const identity = await loadIdentity(body);
      if (!identity) return json({ error: "A valid session token is required" }, 401);
      const ownerColumnName = identity.type === "user" ? "user_id" : "session_id";
      const { data: audit, error } = await supabase.from("hardware_audits").select("*").eq("id", body.audit_id).eq(ownerColumnName, identity.id).single();
      if (error || !audit) return json({ error: "Audit not found" }, 404);
      const { data: findings } = await supabase.from("hardware_audit_findings").select("*").eq("audit_id", body.audit_id).order("severity");
      const bytes = await createReportPdf(audit, findings || []);
      const path = `_exports/${crypto.randomUUID()}-hardware-audit.pdf`;
      const { error: uploadError } = await supabase.storage.from("tyk-documents").upload(path, bytes, { contentType: "application/pdf" });
      if (uploadError) return json({ error: "Could not create audit report." }, 500);
      const { data: signed, error: signedError } = await supabase.storage.from("tyk-documents").createSignedUrl(path, 600, { download: `${audit.project_name || "hardware-audit"}.pdf` });
      if (signedError) return json({ error: "Could not create secure report download." }, 500);
      return json({ url: signed.signedUrl, expiresIn: 600 });
    }

    if (body.action === "export-reviewed") {
      const identity = await loadIdentity(body);
      if (!identity) return json({ error: "A valid session token is required" }, 401);
      const ownerColumnName = identity.type === "user" ? "user_id" : "session_id";
      const { data: audit, error } = await supabase.from("hardware_audits").select("*").eq("id", body.audit_id).eq(ownerColumnName, identity.id).single();
      if (error || !audit) return json({ error: "Audit not found" }, 404);
      const { data: document } = await supabase.from("documents").select("file_path, file_type, name").eq("id", audit.document_id).single();
      const { data: findings } = await supabase.from("hardware_audit_findings").select("*").eq("audit_id", audit.id).order("severity");
      if (!document?.file_path) return json({ error: "The original schedule file is unavailable." }, 409);
      const { data: original, error: downloadError } = await supabase.storage.from("tyk-documents").download(document.file_path);
      if (downloadError || !original) return json({ error: "Could not read the original schedule." }, 500);
      const bytes = new Uint8Array(await original.arrayBuffer());
      const reviewed = (document.file_type || "").includes("pdf") || document.name?.toLowerCase().endsWith(".pdf")
        ? await createReviewedPdf(audit, findings || [], bytes)
        : await createReportPdf(audit, findings || []);
      const path = `_exports/${crypto.randomUUID()}-reviewed-hardware-audit.pdf`;
      const { error: uploadError } = await supabase.storage.from("tyk-documents").upload(path, reviewed, { contentType: "application/pdf" });
      if (uploadError) return json({ error: "Could not create the reviewed schedule." }, 500);
      const { data: signed, error: signedError } = await supabase.storage.from("tyk-documents").createSignedUrl(path, 600, { download: `${audit.project_name || "hardware-schedule"}-reviewed.pdf` });
      if (signedError) return json({ error: "Could not create the reviewed schedule download." }, 500);
      return json({ url: signed.signedUrl, expiresIn: 600, format: "pdf" });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error("hardware-audit error:", error);
    return json({ error: "Hardware audit failed." }, 500);
  }
});
