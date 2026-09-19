// Background Research Engine - TYK keeps learning when nobody is logged in.
// Runs on a schedule (pg_cron -> pg_net -> this function, see migration),
// never from the browser. Strictly budget-limited per run and only ever
// fetches from a small curated set of authoritative sources or a URL the
// company has already confirmed (a manufacturer/supplier's "website" fact) -
// this deliberately does NOT crawl the open internet or guess URLs.
import { generateAnswer } from "../_shared/ai-router.ts";
import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { hasPermission } from "../_shared/permissions.ts";
import { researchWeb, saveWebResearch } from "../_shared/web-research.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ---------------------------------------------------------------------------
// Resource limits - background research must never turn into an unbounded
// crawl or a runaway AI bill.
// ---------------------------------------------------------------------------
const MAX_TASKS_PER_RUN = 5;
const MIN_RESEARCH_QUEUE = Number(Deno.env.get("MIN_RESEARCH_QUEUE") || 100);
const INITIAL_LEARNING_DAYS = 30;
const INITIAL_CADENCE_HOURS = 1;
const STEADY_CADENCE_HOURS = 3;
const MAX_AI_CALLS_PER_RUN = 5;
const MAX_WEB_REQUESTS_PER_RUN = 10;
const MAX_ATTEMPTS = 3;
const RECHECK_DAYS_CODE = 30;
const RECHECK_DAYS_SOURCE = 60;
const RETRY_BACKOFF_DAYS = 3;
const FETCH_TIMEOUT_MS = 10000;

// Source hierarchy, tier 1 (official government) - the ONLY URLs this engine
// is allowed to fetch on its own initiative (everything else must come from
// an already company-confirmed source, e.g. a manufacturer's "website" fact).
// Deliberately small and curated - "do not blindly crawl the internet".
const SEED_CODE_SOURCES = [
  {
    topic: "Ontario Building Code - official source",
    url: "https://www.ontario.ca/laws/regulation/120332",
    sourceType: "government",
  },
  {
    topic: "Ontario Fire Code - official source",
    url: "https://www.ontario.ca/laws/regulation/070213",
    sourceType: "government",
  },
];

const RESEARCH_AREAS = [
  "commercial door hardware",
  "exit devices and panic hardware",
  "door closers",
  "locks and leversets",
  "mortise locks",
  "rim and mortise exit devices",
  "electric strikes and electric locks",
  "hinges and continuous hinges",
  "thresholds weatherstripping and door sweeps",
  "automatic operators and access control",
  "door frames steel doors and hollow metal",
  "aluminum doors storefront and glazing",
  "hardware schedules and door schedules",
  "shop drawings and installation procedures",
  "manufacturer installation manuals",
  "manufacturer catalogs and technical bulletins",
  "product compatibility and part number cross references",
  "Ontario building and fire requirements",
  "commercial door hardware suppliers and distributors",
  "Tykel terminology and lessons learned",
];

const RESEARCH_VARIANTS = [
  "Find authoritative documentation for",
  "Find manufacturer product families for",
  "Find current installation manuals for",
  "Find current catalogs and technical bulletins for",
  "Research compatibility and related products for",
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function logResearch(entry) {
  try {
    await supabase.from("research_log").insert(entry);
  } catch (err) {
    console.error("Failed to write research log (ignored):", err);
  }
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Task generation - research grows from real knowledge gaps, mirroring Teach
// TYK's coverage model rather than an arbitrary crawl list.
// ---------------------------------------------------------------------------

// Ensures the two fixed Ontario code sources are always in the queue -
// "maintain explicit source coverage" for the core codes, regardless of
// what's been discovered from conversations yet.
async function ensureCodeTasks() {
  for (const source of SEED_CODE_SOURCES) {
    await supabase.from("research_queue").upsert({
      topic: source.topic,
      title: source.topic,
      description: `Confirm the official ${source.sourceType} source for this code hasn't changed, and store a new version if it has.`,
      type: "CHANGE_CHECK",
      entity_id: null,
      entity_name: null,
      reason: "Core Ontario code/requirement coverage TYK must maintain.",
      priority: 8,
      source_type: source.sourceType,
      status: "queued",
    }, { onConflict: "topic,entity_id", ignoreDuplicates: true });
  }
}

async function ensureResearchAreaTasks() {
  const topics = RESEARCH_AREAS.flatMap((area) => [
    `Research ${area}`,
    ...RESEARCH_VARIANTS.map((variant) => `${variant} ${area}`),
  ]);
  const { data: existing } = await supabase
    .from("research_queue")
    .select("topic, status, next_research_date")
    .in("topic", topics);
  const existingByTopic = new Map((existing || []).map((task) => [task.topic, task]));
  const now = new Date().toISOString();
  const missingTasks = [];

  for (const area of RESEARCH_AREAS) {
    const taskDefinitions = [
      { title: `Research ${area}`, priority: /fire|exit|compatibility|installation/i.test(area) ? 7 : 4 },
      ...RESEARCH_VARIANTS.map((variant) => ({
        title: `${variant} ${area}`,
        priority: /fire|exit|compatibility|installation/i.test(area) ? 6 : 3,
      })),
    ];

    for (const definition of taskDefinitions) {
      const title = definition.title;
      const current = existingByTopic.get(title);
      if (current?.status === "done" && current.next_research_date && current.next_research_date <= now) {
        await supabase.from("research_queue").update({
          status: "queued",
          updated_at: now,
        }).eq("topic", title).eq("status", "done");
      }
      if (current) continue;

      missingTasks.push({
        topic: title,
        title,
        description: `Find authoritative, reusable evidence about ${area}; prefer official, standards, manufacturer, and authorized technical sources.`,
        type: "RESEARCH",
        reason: `Systematic coverage of the ${area} research domain.`,
        priority: definition.priority,
        source_type: "web_search",
        search_queries: [area, `${area} official documentation`, `${area} manufacturer technical information`],
        status: "queued",
      });
    }
  }

  if (missingTasks.length) await supabase.from("research_queue").insert(missingTasks);
}

async function createResearchFollowups(discoveredKnowledge) {
  const entityName = discoveredKnowledge?.entityName;
  if (!entityName) return;

  const followups = [
    `Research ${entityName} manufacturer and official product page`,
    `Find ${entityName} installation manual`,
    `Find ${entityName} current catalog and technical bulletins`,
    `Research ${entityName} compatible trims and accessories`,
    `Research ${entityName} related and replacement models`,
    `Verify ${entityName} documentation is current`,
  ];
  const { data: existing } = await supabase
    .from("research_queue")
    .select("topic")
    .in("topic", followups);
  const known = new Set((existing || []).map((task) => task.topic));

  for (const title of followups) {
    if (known.has(title)) continue;
    await supabase.from("research_queue").insert({
      topic: title,
      title,
      description: `Follow-up research generated from the source-backed discovery of ${entityName}.`,
      type: "RESEARCH",
      entity_name: entityName,
      priority: 6,
      source_type: "web_search",
      search_queries: [title, `${entityName} official documentation`, `${entityName} manufacturer`],
      reason: "A source-backed discovery created additional legitimate documentation and relationship gaps.",
      status: "queued",
    });
  }
}

async function insertResearchTasks(tasks) {
  if (!tasks.length) return 0;
  const topics = tasks.map((task) => task.topic);
  const existing = [];
  for (let index = 0; index < topics.length; index += 20) {
    const { data } = await supabase
      .from("research_queue")
      .select("topic")
      .in("topic", topics.slice(index, index + 20));
    existing.push(...(data || []));
  }
  const known = new Set(existing.map((task) => task.topic));
  const missing = tasks
    .filter((task) => !known.has(task.topic))
    .map((task) => ({
      ...task,
      status: task.status || "queued",
      source_type: task.source_type || "web_search",
      priority: task.priority || 6,
    }));
  if (!missing.length) return 0;
  let created = 0;
  for (let index = 0; index < missing.length; index += 20) {
    const batch = missing.slice(index, index + 20);
    const { error } = await supabase.from("research_queue").insert(batch);
    if (!error) {
      created += batch.length;
      continue;
    }

    console.error("Research queue batch insert failed; retrying individually:", error.code || "unknown");
    for (const task of batch) {
      const { error: singleError } = await supabase.from("research_queue").insert(task);
      if (!singleError) created++;
    }
  }
  return created;
}

async function expandCompletedTask(task, outcome) {
  const topics = [];
  const taskText = `${task.topic} ${task.title || ""}`;
  if (/Ontario Fire Code|Ontario Building Code/i.test(taskText)) {
    const codeName = /Fire Code/i.test(taskText) ? "Ontario Fire Code" : "Ontario Building Code";
    const subjects = [
      "current edition and effective date",
      "fire separation requirements",
      "fire door assembly requirements",
      "self-closing requirements",
      "positive latching requirements",
      "exit and egress requirements",
      "panic and fire exit hardware requirements",
      "hold-open and automatic operator requirements",
      "access control and electrified hardware requirements",
      "door and frame labeling requirements",
      "referenced standards and definitions",
      "exceptions and exemptions",
      "inspection and maintenance requirements",
      "changes from the previous edition",
    ];
    topics.push(...subjects.map((subject) => ({
      topic: `Research ${codeName} ${subject}`,
      title: `Research ${codeName} ${subject}`,
      description: `Investigate this specific follow-up objective discovered while expanding ${codeName}.`,
      type: "RESEARCH",
      priority: 9,
      source_type: "government",
      search_queries: [`${codeName} ${subject}`, `${codeName} official ${subject}`],
      reason: `Follow-up generated from completed ${codeName} source research.`,
    })));
  }

  if (/verify all indexed source urls/i.test(taskText)) {
    topics.push({
      topic: `Reverify indexed source URLs (${new Date().toISOString().slice(0, 7)})`,
      title: "Reverify indexed source URLs",
      description: "Recheck current indexed source URLs for availability and changed documents.",
      type: "VERIFY",
      priority: 5,
      source_type: "other",
      reason: "Periodic source maintenance objective.",
    });
  }

  if (outcome?.discoveredKnowledge?.entityName) {
    const name = outcome.discoveredKnowledge.entityName;
    topics.push(...[
      "product page",
      "installation manual",
      "current catalog",
      "technical bulletins",
      "compatible accessories and related models",
      "current documentation revision",
    ].map((subject) => ({
      topic: `Research ${name} ${subject}`,
      title: `Research ${name} ${subject}`,
      description: `Follow-up research generated from the discovered entity ${name}.`,
      type: "RESEARCH",
      priority: 7,
      source_type: "web_search",
      search_queries: [`${name} ${subject}`, `${name} official documentation`],
      entity_name: name,
      reason: "A completed research task revealed additional legitimate research objectives.",
    })));
  }

  return insertResearchTasks(topics);
}

async function ensureMinimumQueue() {
  const { count } = await supabase
    .from("research_queue")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "researching", "reverify", "needs_review"]);
  const deficit = MIN_RESEARCH_QUEUE - (count || 0);
  if (deficit <= 0) return 0;

  const cycle = new Date().toISOString().slice(0, 7);
  const tasks = RESEARCH_AREAS.flatMap((area) => [
    { area, subject: "coverage" },
    ...RESEARCH_VARIANTS.map((variant) => ({ area, subject: variant.toLowerCase() })),
  ]).map(({ area, subject }) => {
    return {
      topic: `Reverify ${area} ${subject} (${cycle})`,
      title: `Reverify ${area} ${subject}`,
      description: `Review known evidence and identify the next missing source, document, relationship, or current revision for ${area}.`,
      type: "RESEARCH",
      priority: /fire|exit|compatibility|installation/i.test(area) ? 7 : 4,
      source_type: "other",
      search_queries: [area, `${area} current documentation`, `${area} manufacturer technical bulletin`],
      reason: "Minimum backlog maintenance: reverify an active knowledge area and generate its next gaps.",
    };
  });

  const topics = tasks.map((task) => task.topic);
  const existing = [];
  for (let index = 0; index < topics.length; index += 20) {
    const { data } = await supabase
      .from("research_queue")
      .select("topic, status")
      .in("topic", topics.slice(index, index + 20));
    existing.push(...(data || []));
  }
  const requeueTopics = existing
    .filter((task) => task.status === "done" || task.status === "failed")
    .map((task) => task.topic);
  for (let index = 0; index < requeueTopics.length; index += 20) {
    await supabase.from("research_queue").update({
      status: "queued",
      updated_at: new Date().toISOString(),
    }).in("topic", requeueTopics.slice(index, index + 20));
  }

  const { count: afterRequeue } = await supabase
    .from("research_queue")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "researching", "reverify", "needs_review"]);
  const remaining = MIN_RESEARCH_QUEUE - (afterRequeue || 0);
  if (remaining <= 0) return 0;

  const refreshTasks = RESEARCH_AREAS.flatMap((area) => [
    { area, subject: "coverage refresh" },
    ...RESEARCH_VARIANTS.map((variant) => ({ area, subject: `${variant.toLowerCase()} refresh` })),
  ]).map(({ area, subject }) => ({
    topic: `Reverify ${area} ${subject} (${cycle})`,
    title: `Reverify ${area} ${subject}`,
    description: `Review current evidence and identify the next real research gap for ${area}.`,
    type: "RESEARCH",
    priority: /fire|exit|compatibility|installation/i.test(area) ? 7 : 4,
    source_type: "other",
    reason: "Minimum backlog maintenance: continue researching and re-verifying a real TYK knowledge area.",
  }));
  return insertResearchTasks(refreshTasks.slice(0, remaining));
}

// Any manufacturer/supplier with a COMPANY-CONFIRMED website but a missing
// installation_manual/current_catalog becomes a research task - this is the
// "known: Von Duprin 99 -> unknown: installation manual" pattern from the spec.
async function generateGapTasks() {
  const { data: gaps } = await supabase
    .from("knowledge_facts")
    .select("id, fact_key, entity_id, knowledge_entities(name, entity_type)")
    .in("fact_key", ["installation_manual", "current_catalog"])
    .in("status", ["missing", "uncertain"])
    .limit(30);

  for (const gap of gaps || []) {
    const entity = gap.knowledge_entities;
    if (!entity) continue;

    const { data: website } = await supabase
      .from("knowledge_facts")
      .select("fact_value")
      .eq("entity_id", gap.entity_id)
      .eq("fact_key", "website")
      .eq("status", "confirmed")
      .maybeSingle();

    // No company-confirmed website yet - nothing legitimate to research from.
    if (!website?.fact_value) continue;

    const label = gap.fact_key === "installation_manual" ? "installation documentation" : "current catalog";
    const title = `Find ${entity.name}'s ${label}`;

    await supabase.from("research_queue").upsert({
      topic: title,
      title,
      description: `${entity.name} is a company-confirmed ${entity.entity_type} but its ${label} is still missing.`,
      type: "DOCUMENT",
      entity_id: gap.entity_id,
      entity_name: entity.name,
      reason: `Company knowledge confirms ${entity.name} as a known ${entity.entity_type}, but ${label} is still missing.`,
      priority: entity.entity_type === "manufacturer" ? 7 : 6,
      source_type: entity.entity_type === "supplier" ? "supplier" : "manufacturer",
      status: "queued",
    }, { onConflict: "topic,entity_id", ignoreDuplicates: true });
  }
}

// If there's genuinely no fresh knowledge gap to chase right now, TYK falls
// back to real maintenance work instead of ever sitting idle - "never
// intentionally empty" without inventing meaningless busywork. Every task
// here does something real and checkable, never a fake placeholder question.
async function generateMaintenanceTasks() {
  await supabase.from("research_queue").upsert({
    topic: "Verify all indexed source URLs are still reachable",
    title: "Verify all indexed source URLs are still reachable",
    description: "Check every currently-indexed document's source_url with a lightweight request and flag any that no longer respond.",
    type: "VERIFY",
    entity_id: null,
    entity_name: null,
    reason: "Routine maintenance - links break over time; TYK should notice before a user does.",
    priority: 3,
    source_type: "other",
    status: "queued",
  }, { onConflict: "topic,entity_id", ignoreDuplicates: true });

  await supabase.from("research_queue").upsert({
    topic: "Review knowledge entities with no confirmed facts yet",
    title: "Review knowledge entities with no confirmed facts yet",
    description: "Identify manufacturers/suppliers/products TYK knows by name but has no confirmed facts for, so they can be prioritized for Teach TYK or research.",
    type: "MAINTENANCE",
    entity_id: null,
    entity_name: null,
    reason: "Routine maintenance - surfaces knowledge gaps that don't fit the installation-manual/catalog pattern.",
    priority: 2,
    source_type: "other",
    status: "queued",
  }, { onConflict: "topic,entity_id", ignoreDuplicates: true });
}

// Item 7 - "when a pending item is completed, evaluate what should be
// learned next": a small deterministic chain (no AI) so completing one task
// naturally spawns the next logical one, instead of the queue just shrinking
// to zero over time.
async function replenishAfterCompletion(task) {
  if (!task.entity_id || !task.entity_name) return;

  if (task.type === "DOCUMENT" && /installation documentation/i.test(task.topic)) {
    const title = `Find ${task.entity_name}'s current catalog`;
    await supabase.from("research_queue").upsert({
      topic: title,
      title,
      description: `Follow-up to finding ${task.entity_name}'s installation documentation - the current catalog is the next useful document to locate.`,
      type: "DOCUMENT",
      entity_id: task.entity_id,
      entity_name: task.entity_name,
      reason: "Auto-generated follow-up after completing a related research task.",
      priority: (task.priority || 5) - 1,
      source_type: task.source_type,
      status: "queued",
    }, { onConflict: "topic,entity_id", ignoreDuplicates: true });
  } else if (task.type === "DOCUMENT" && /current catalog/i.test(task.topic)) {
    const title = `Verify ${task.entity_name}'s catalog is the current edition`;
    await supabase.from("research_queue").upsert({
      topic: title,
      title,
      description: `Follow-up to finding ${task.entity_name}'s catalog - confirm it's still the latest edition available.`,
      type: "VERIFY",
      entity_id: task.entity_id,
      entity_name: task.entity_name,
      reason: "Auto-generated follow-up after completing a related research task.",
      priority: (task.priority || 5) - 1,
      source_type: task.source_type,
      status: "queued",
    }, { onConflict: "topic,entity_id", ignoreDuplicates: true });
  }
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

async function researchCodeSource(task, budget) {
  const source = SEED_CODE_SOURCES.find((s) => s.topic === task.topic);
  if (!source) return { result: "No matching seed source.", failures: "unknown code task" };
  if (budget.webRequests >= MAX_WEB_REQUESTS_PER_RUN) {
    return { result: "Skipped - web request budget exhausted for this run.", deferred: true };
  }

  budget.webRequests++;
  let html;
  try {
    html = await fetchWithTimeout(source.url);
  } catch (err) {
    return { result: null, failures: `Fetch failed: ${err.message}` };
  }

  const text = stripHtml(html).slice(0, 20000);
  const hash = await sha256(text);

  const { data: existing } = await supabase
    .from("documents")
    .select("id, auto_metadata, chunk_count")
    .eq("source_url", source.url)
    .eq("is_current", true)
    .maybeSingle();

  const previousHash = existing?.auto_metadata?.content_hash;
  const changed = previousHash && previousHash !== hash;
  const isNew = !existing;

  if (isNew) {
    await supabase.from("documents").insert({
      name: source.topic,
      description: "Auto-discovered by TYK background research.",
      file_path: null,
      status: "indexed",
      chunk_count: 0,
      source_type: source.sourceType,
      source_url: source.url,
      is_current: true,
      auto_metadata: { content_hash: hash, discovered_by: "background_research" },
    });
  } else if (changed) {
    // Never silently overwrite - the old row is kept, marked superseded.
    await supabase.from("documents").update({ is_current: false }).eq("id", existing.id);
    const { data: newDoc } = await supabase.from("documents").insert({
      name: source.topic,
      description: "Auto-discovered by TYK background research (updated).",
      status: "indexed",
      chunk_count: 0,
      source_type: source.sourceType,
      source_url: source.url,
      is_current: true,
      previous_version_id: existing.id,
      auto_metadata: { content_hash: hash, discovered_by: "background_research" },
    }).select().single();
    return {
      result: `Change detected at official source - new version stored (previous kept as history).`,
      documentsFound: 1,
      changesDiscovered: { previousDocumentId: existing.id, newDocumentId: newDoc?.id },
    };
  } else if (existing) {
    return { result: "No change since last check.", documentsFound: 0 };
  }

  return { result: isNew ? "First discovery of this official source." : "Recorded.", documentsFound: isNew ? 1 : 0 };
}

// Finds obvious PDF links (installation manual / catalog) on a company-
// confirmed manufacturer/supplier website - pure regex, zero AI, matches
// "do not use AI for simple deterministic extraction".
function findPdfCandidates(html, baseUrl) {
  const links = [...html.matchAll(/<a\s+[^>]*href=["']([^"']+\.pdf[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  return links.slice(0, 15).map((m) => {
    let href = m[1];
    try {
      href = new URL(href, baseUrl).toString();
    } catch {
      // leave as-is if it can't be resolved
    }
    return { url: href, label: stripHtml(m[2]).slice(0, 120) };
  });
}

async function researchEntitySource(task, budget) {
  const { data: website } = await supabase
    .from("knowledge_facts")
    .select("fact_value")
    .eq("entity_id", task.entity_id)
    .eq("fact_key", "website")
    .eq("status", "confirmed")
    .maybeSingle();

  if (!website?.fact_value) {
    return { result: null, failures: "No company-confirmed website to research from." };
  }

  if (budget.webRequests >= MAX_WEB_REQUESTS_PER_RUN) {
    return { result: "Skipped - web request budget exhausted for this run.", deferred: true };
  }

  budget.webRequests++;
  let html;
  try {
    html = await fetchWithTimeout(website.fact_value);
  } catch (err) {
    return { result: null, failures: `Fetch failed: ${err.message}` };
  }

  const candidates = findPdfCandidates(html, website.fact_value);
  if (candidates.length === 0) {
    return { result: "No installation/catalog documents found on the confirmed website.", documentsFound: 0 };
  }

  const wantsManual = /installation/i.test(task.topic);
  const relevant = candidates.filter((c) =>
    wantsManual
      ? /install|manual|template/i.test(c.label + c.url)
      : /catalog|brochure/i.test(c.label + c.url)
  );
  const pool = relevant.length ? relevant : candidates;

  let chosen = pool[0];
  let aiUsed = false;
  // AI only breaks a genuine tie among plausible candidates - never used for
  // the deterministic PDF-link extraction itself.
  if (pool.length > 1 && budget.aiCalls < MAX_AI_CALLS_PER_RUN) {
    budget.aiCalls++;
    aiUsed = true;
    try {
      const prompt = `TYK is looking for ${task.entity_name}'s ${wantsManual ? "installation manual" : "current catalog"} on their official website.\n\nCandidate PDF links found:\n${
        pool.map((c, i) => `${i}: ${c.label} (${c.url})`).join("\n")
      }\n\nRespond with ONLY the index number of the single best match.`;
      const { answer } = await generateAnswer(prompt);
      const idx = parseInt(answer.trim().match(/\d+/)?.[0] ?? "", 10);
      if (Number.isInteger(idx) && pool[idx]) chosen = pool[idx];
    } catch (err) {
      console.error("AI tie-break failed for research task (using first candidate):", err);
    }
  }

  const factKey = wantsManual ? "installation_manual" : "current_catalog";

  await supabase.from("knowledge_facts").upsert({
    entity_id: task.entity_id,
    fact_key: factKey,
    fact_value: chosen.url,
    status: "confirmed",
    // A background-discovered link is a verified-source fact, NOT yet
    // company-confirmed/approved - a human still needs to look at it.
    research_state: "verified_source",
    source_type: "background_research",
    updated_at: new Date().toISOString(),
  }, { onConflict: "entity_id,fact_key" });

  return {
    result: `Found candidate ${factKey.replace("_", " ")} at ${chosen.url}${aiUsed ? " (AI tie-break used)" : ""}.`,
    documentsFound: 1,
    aiUsed,
  };
}

async function researchWebTask(task, budget) {
  if (budget.aiCalls >= MAX_AI_CALLS_PER_RUN) {
    return { result: "Deferred - research AI budget exhausted for this run.", deferred: true };
  }

  budget.aiCalls++;
  const research = await researchWeb(task.topic, {
    searchQueries: Array.isArray(task.search_queries) && task.search_queries.length
      ? task.search_queries
      : undefined,
  });
  if (!research) {
    return { result: null, failures: "No grounded web evidence was returned." };
  }

  await saveWebResearch(research);
  await createResearchFollowups(research);
  return {
    result: `Found ${research.sources.length} grounded source(s) for ${task.topic}.`,
    documentsFound: research.sources.length,
    knowledgeCreated: research.facts?.length || 0,
    discoveredKnowledge: {
      topic: research.topic,
      entityName: research.entityName,
      facts: research.facts,
      sources: research.sources.map((source) => ({ url: source.url, title: source.title })),
    },
    confidence: research.confidence,
    aiUsed: true,
  };
}

// Deterministic (zero-AI) maintenance work - the "if knowledge is already
// complete, switch to maintenance/research tasks" fallback. Every check here
// is a real HTTP/DB check, never a fabricated question.
async function runMaintenanceTask(task, budget) {
  if (/verify all indexed source urls/i.test(task.topic)) {
    const { data: docs } = await supabase
      .from("documents")
      .select("id, name, source_url")
      .eq("is_current", true)
      .not("source_url", "is", null)
      .limit(20);

    if (!docs?.length) return { result: "No source URLs indexed yet to verify.", documentsFound: 0 };

    let broken = 0;
    for (const doc of docs) {
      if (budget.webRequests >= MAX_WEB_REQUESTS_PER_RUN) break;
      budget.webRequests++;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(doc.source_url, { method: "HEAD", signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) broken++;
      } catch {
        broken++;
      }
    }

    return {
      result: broken > 0
        ? `Checked ${docs.length} source URL(s) - ${broken} no longer responded correctly.`
        : `Checked ${docs.length} source URL(s) - all still reachable.`,
      documentsFound: 0,
      changesDiscovered: broken > 0 ? { brokenCount: broken } : null,
    };
  }

  if (/review knowledge entities with no confirmed facts/i.test(task.topic)) {
    const { data: entities } = await supabase
      .from("knowledge_entities")
      .select("id, name, entity_type, knowledge_facts(status)")
      .limit(100);

    const gaps = (entities || []).filter(
      (e) => !(e.knowledge_facts || []).some((f) => f.status === "confirmed"),
    );

    return {
      result: gaps.length
        ? `${gaps.length} entit${gaps.length === 1 ? "y has" : "ies have"} no confirmed facts yet: ${
          gaps.slice(0, 5).map((e) => e.name).join(", ")
        }${gaps.length > 5 ? ", ..." : ""}.`
        : "Every known entity already has at least one confirmed fact.",
      documentsFound: 0,
    };
  }

  return { result: "No matching maintenance task handler.", failures: "unknown maintenance task" };
}

async function runResearch() {
  await ensureCodeTasks();
  await ensureResearchAreaTasks();
  await generateGapTasks();
  await ensureMinimumQueue();

  const { count: queuedCount } = await supabase
    .from("research_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "queued");
  if (!queuedCount) {
    // Nothing fresh to chase - fall back to real maintenance work rather
    // than ever leaving the queue empty.
    await generateMaintenanceTasks();
  }

  const { data: tasks } = await supabase
    .from("research_queue")
    .select("*")
    .in("status", ["queued", "reverify", "failed"])
    .lt("attempts", MAX_ATTEMPTS)
    .or(`next_research_date.is.null,next_research_date.lte.${new Date().toISOString()}`)
    .order("priority", { ascending: false })
    .order("updated_at", { ascending: true })
    .limit(MAX_TASKS_PER_RUN);

  const budget = { aiCalls: 0, webRequests: 0 };
  const summary = { tasksRun: 0, documentsFound: 0, knowledgeCreated: 0, failures: 0 };

  for (const task of tasks || []) {
    if (budget.webRequests >= MAX_WEB_REQUESTS_PER_RUN) break;

    await supabase.from("research_queue").update({ status: "researching" }).eq("id", task.id);

    const isCodeSource = SEED_CODE_SOURCES.some((s) => s.topic === task.topic);
    let outcome;
    try {
      outcome = task.type === "RESEARCH"
        ? await researchWebTask(task, budget)
        : task.entity_id
        ? await researchEntitySource(task, budget)
        : isCodeSource
        ? await researchCodeSource(task, budget)
        : await runMaintenanceTask(task, budget);
    } catch (err) {
      console.error("Research task execution failed:", err);
      outcome = { result: null, failures: "Research provider or source unavailable; retry scheduled." };
    }

    summary.tasksRun++;
    if (outcome.documentsFound) summary.documentsFound += outcome.documentsFound;
    if (outcome.failures) summary.failures++;

    const attempts = (task.attempts || 0) + (outcome.failures ? 1 : 0);
    const nextStatus = outcome.deferred
      ? "queued"
      : outcome.failures
      ? (attempts >= MAX_ATTEMPTS ? "failed" : "queued")
      : "done";
    const recheckDays = task.source_type === "government" ? RECHECK_DAYS_CODE : RECHECK_DAYS_SOURCE;
    const nextDate = new Date(
      Date.now() + (outcome.failures ? RETRY_BACKOFF_DAYS : recheckDays) * 86400000,
    ).toISOString();

    await supabase.from("research_queue").update({
      status: nextStatus,
      attempts,
      result: outcome.result || null,
      last_researched_at: new Date().toISOString(),
      last_attempted_at: new Date().toISOString(),
      next_research_date: outcome.deferred ? task.next_research_date : nextDate,
      next_attempt_at: outcome.deferred ? task.next_attempt_at : nextDate,
      retry_count: attempts,
      confidence: outcome.confidence || null,
      discovered_knowledge: outcome.discoveredKnowledge || {},
      updated_at: new Date().toISOString(),
    }).eq("id", task.id);

    if (nextStatus === "done") {
      await replenishAfterCompletion(task);
    }

    const followUpTasksCreated = nextStatus === "done"
      ? await expandCompletedTask(task, outcome)
      : 0;

    await logResearch({
      task_id: task.id,
      task_topic: task.topic,
      source: task.entity_id ? "company-confirmed website" : SEED_CODE_SOURCES.find((s) => s.topic === task.topic)?.url,
      source_type: task.source_type,
      result: outcome.result,
      documents_found: outcome.documentsFound || 0,
      knowledge_created: outcome.documentsFound ? 1 : 0,
      ai_calls: outcome.aiUsed ? 1 : 0,
      failures: outcome.failures || null,
      changes_discovered: outcome.changesDiscovered || null,
    });

    await supabase.from("research_queue").update({
      research_depth: (task.research_depth || 0) + 1,
      research_attempts: (task.research_attempts || 0) + 1,
      sources_checked: outcome.documentsFound || 0,
      authoritative_sources_found: outcome.documentsFound || 0,
      follow_up_tasks_created: followUpTasksCreated,
      knowledge_records_created: outcome.knowledgeCreated || 0,
      completeness_state: outcome.failures
        ? "RESEARCH_BLOCKED"
        : followUpTasksCreated > 0
        ? "PARTIALLY_RESEARCHED"
        : "WELL_RESEARCHED",
      next_research_at: nextDate,
    }).eq("id", task.id);
  }

  summary.queueReplenished = await ensureMinimumQueue();

  return summary;
}

async function getResearchCadence() {
  const { data: firstTask } = await supabase
    .from("research_queue")
    .select("created_at")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const activatedAt = firstTask?.created_at ? new Date(firstTask.created_at) : new Date();
  const initialPeriodEndsAt = new Date(activatedAt.getTime() + INITIAL_LEARNING_DAYS * 86400000);
  const initialPeriod = Date.now() < initialPeriodEndsAt.getTime();
  return {
    activatedAt: activatedAt.toISOString(),
    initialPeriodEndsAt: initialPeriodEndsAt.toISOString(),
    hours: initialPeriod ? INITIAL_CADENCE_HOURS : STEADY_CADENCE_HOURS,
    label: initialPeriod ? "Hourly — Initial learning period" : "Every 3 hours",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

    if (body.action === "queue") {
      // Viewable by either research-dashboard access or company-knowledge
      // approval access - the Settings "pending" panel falls back to
      // showing active queue work for approvers who don't have the full
      // Research dashboard permission.
      if (
        !(await hasPermission(body, "can_view_research")) &&
        !(await hasPermission(body, "can_approve_company_knowledge"))
      ) {
        return json({ error: "Forbidden" }, 403);
      }

      // Queue reads also perform the cheap deterministic replenishment pass.
      // This keeps the Pending Company Knowledge panel meaningful between
      // scheduled worker runs without researching or calling AI from the UI.
      await ensureCodeTasks();
      await ensureResearchAreaTasks();
      await generateGapTasks();
      const replenished = await ensureMinimumQueue();
      const { count: queuedCount } = await supabase
        .from("research_queue")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "researching", "reverify", "needs_review"]);
      if (!queuedCount) await generateMaintenanceTasks();

      const { count: activeCount } = await supabase
        .from("research_queue")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "researching", "reverify", "needs_review"]);

      const { data, error } = await supabase
        .from("research_queue")
        .select("*")
        .order("priority", { ascending: false })
        .order("updated_at", { ascending: false })
        .limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({
        queue: data || [],
        queueStats: {
          target: MIN_RESEARCH_QUEUE,
          active: activeCount || 0,
          replenished: replenished || 0,
        },
      });
    }

    if (body.action === "log") {
      if (!(await hasPermission(body, "can_view_research"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { data, error } = await supabase
        .from("research_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) return json({ error: error.message }, 500);
      return json({ log: data || [] });
    }

    // Admin-only internal health snapshot - never exposed to normal users,
    // deliberately reports STATUS ONLY (never raw provider errors/stack
    // traces) so an admin can see the system is healthy without leaking
    // anything a normal user-facing error message wouldn't already hide.
    if (body.action === "health") {
      if (!(await hasPermission(body, "can_view_research"))) {
        return json({ error: "Forbidden" }, 403);
      }

      const [
        { count: queueTotal },
        { count: queueQueued },
        { count: queueResearching },
        { data: lastLog },
        { data: providers },
        { data: buckets },
        { count: documentCount },
        { count: completedToday },
        { count: sourceCount },
        { count: entityCount },
        cadence,
      ] = await Promise.all([
        supabase.from("research_queue").select("id", { count: "exact", head: true }),
        supabase.from("research_queue").select("id", { count: "exact", head: true }).eq("status", "queued"),
        supabase.from("research_queue").select("id", { count: "exact", head: true }).eq("status", "researching"),
        supabase.from("research_log").select("created_at").order("created_at", { ascending: false }).limit(1),
        supabase.from("provider_health").select("provider, available, cooldown_until, last_success"),
        supabase.storage.listBuckets(),
        supabase.from("documents").select("id", { count: "exact", head: true }),
        supabase.from("research_log").select("id", { count: "exact", head: true }).gte("created_at", new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
        supabase.from("web_sources").select("id", { count: "exact", head: true }),
        supabase.from("knowledge_entities").select("id", { count: "exact", head: true }),
        getResearchCadence(),
      ]);

      const now = Date.now();
      return json({
        health: {
          database: "ok",
          documentStorage: buckets?.length ? "ok" : "unknown",
          documentsIndexed: documentCount || 0,
          researchQueue: {
            total: queueTotal || 0,
            queued: queueQueued || 0,
            researching: queueResearching || 0,
            completedToday: completedToday || 0,
            lastRun: lastLog?.[0]?.created_at || null,
          },
          sourcesIndexed: sourceCount || 0,
          entitiesKnown: entityCount || 0,
          cadence: {
            ...cadence,
            nextRunAt: lastLog?.[0]?.created_at
              ? new Date(new Date(lastLog[0].created_at).getTime() + cadence.hours * 60 * 60 * 1000).toISOString()
              : new Date().toISOString(),
          },
          aiProviders: (providers || []).map((p) => ({
            provider: p.provider,
            status: p.cooldown_until && new Date(p.cooldown_until).getTime() > now
              ? "cooling_down"
              : p.available
              ? "ok"
              : "unavailable",
            lastSuccess: p.last_success,
          })),
        },
      });
    }

    // Default: this is the scheduled entry point (pg_cron -> pg_net), and
    // also callable manually by an admin for on-demand research.
    if (!body.token) {
      const cadence = await getResearchCadence();
      const { data: latest } = await supabase
        .from("research_log")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const elapsed = latest ? Date.now() - new Date(latest.created_at).getTime() : Infinity;
      if (elapsed < cadence.hours * 60 * 60 * 1000) {
        return json({
          ok: true,
          skipped: true,
          reason: "Scheduled cadence window has not elapsed.",
          cadence,
          nextRunAt: new Date(new Date(latest.created_at).getTime() + cadence.hours * 60 * 60 * 1000).toISOString(),
        });
      }
    }
    const summary = await runResearch();
    return json({ ok: true, summary });
  } catch (err) {
    console.error("background-research error:", err);
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
