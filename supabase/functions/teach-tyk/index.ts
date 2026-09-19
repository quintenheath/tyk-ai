// Continuous knowledge-discovery engine. Instead of a fixed question list,
// TYK maintains a knowledge graph of entities/facts (supplier, manufacturer,
// product family, procedure, ...), scores every open gap deterministically,
// and only calls AI to break genuine ties or interpret free text. Every
// question KNOWS exactly which fact it's targeting, so recording an answer
// almost never needs AI either - only discovering brand-new entities does.
import { generateAnswer } from "../_shared/ai-router.ts";
import { embedText } from "../_shared/embeddings.ts";
import { saveLearnedAnswer } from "../_shared/learned-knowledge.ts";
import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { hasPermission, loadIdentity } from "../_shared/permissions.ts";
import { researchWeb, saveWebResearch } from "../_shared/web-research.ts";

const IMAGE_BUCKET = "tyk-teach-images";
const SIGNED_URL_TTL = 300;

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

// Standard checklist of what "fully known" looks like per entity type.
// Seeded automatically (zero AI) whenever a new entity is discovered.
const DEFAULT_FACTS = {
  manufacturer: [
    "website",
    "product_families",
    "common_applications",
    "preferred_supplier",
    "installation_manual",
    "current_catalog",
  ],
  supplier: [
    "website",
    "products_purchased",
    "manufacturers_carried",
    "supplier_procedures",
  ],
  product_family: [
    "installation_manual",
    "current_catalog",
    "common_applications",
  ],
  procedure: ["steps", "who_approves", "required_photos"],
  // Individual hardware/products (e.g. "4040" closer) - a visual reference
  // photo is often the fastest way for TYK to confirm terminology, per the
  // "is this the hardware you normally call a 4040?" learning pattern.
  product: ["visual_reference"],
};

// Facts confirmed via an image (yes/no on a photo, or choosing among several)
// instead of free text.
const IMAGE_FACT_KEYS = new Set(["visual_reference"]);


// Facts that represent a document TYK should ideally have on file - these
// trigger the upload/source-discovery follow-up flow instead of a plain
// text answer.
const DOCUMENT_FACT_KEYS = new Set(["installation_manual", "current_catalog"]);

const FACT_LABELS = {
  website: "website",
  product_families: "product lines",
  common_applications: "common applications",
  preferred_supplier: "preferred supplier",
  installation_manual: "installation manual",
  current_catalog: "current catalog",
  products_purchased: "products purchased",
  manufacturers_carried: "manufacturers carried",
  supplier_procedures: "ordering procedures",
  steps: "procedure steps",
  who_approves: "who approves it",
  required_photos: "required photos",
  visual_reference: "visual reference photo",
};

function factLabel(factKey) {
  return FACT_LABELS[factKey] || factKey.replace(/_/g, " ");
}

// Deterministic priority weights - higher score = asked sooner. Values
// reflect the priority rules: unlock future answers, connect entities,
// locate documents, prevent future AI calls.
const FACT_WEIGHTS = {
  product_families: 9,
  products_purchased: 9,
  manufacturers_carried: 8,
  installation_manual: 8,
  current_catalog: 7,
  preferred_supplier: 6,
  steps: 5,
  common_applications: 5,
  visual_reference: 5,
  website: 4,
  who_approves: 3,
  required_photos: 3,
  supplier_procedures: 3,
};
const DEFAULT_WEIGHT = 4;

const FACT_QUESTION_TEMPLATES = {
  "manufacturer:product_families": (n) =>
    `Which ${n} product lines/series do you commonly use?`,
  "manufacturer:website": (n) => `What is ${n}'s website, if you know it?`,
  "manufacturer:common_applications": (n) =>
    `Where do you typically use ${n} products (which openings/projects)?`,
  "manufacturer:preferred_supplier": (n) =>
    `Who do you usually purchase ${n} products from?`,
  "manufacturer:installation_manual": (n) =>
    `Do you already have ${n}'s installation manual or template on hand?`,
  "manufacturer:current_catalog": (n) =>
    `Do you already have ${n}'s current product catalog?`,
  "supplier:website": (n) => `What is ${n}'s website or ordering portal?`,
  "supplier:products_purchased": (n) => `What do you typically purchase from ${n}?`,
  "supplier:manufacturers_carried": (n) =>
    `Which manufacturers do you commonly buy through ${n}?`,
  "supplier:supplier_procedures": (n) =>
    `Are there any special procedures for ordering from ${n}?`,
  "product_family:installation_manual": (n) =>
    `Do you already have the ${n} installation manual or template?`,
  "product_family:current_catalog": (n) =>
    `Do you already have current catalog info for ${n}?`,
  "product_family:common_applications": (n) =>
    `What openings/projects is ${n} typically used on?`,
};

function questionForFact(entityType, entityName, factKey) {
  const template = FACT_QUESTION_TEMPLATES[`${entityType}:${factKey}`];
  if (template) return template(entityName);
  return `What can you tell me about ${factLabel(factKey)} for ${entityName}?`;
}

// Revisiting an uncertain fact must explain why, per "do not repeat
// questions" - never re-ask silently.
function revisitQuestionForFact(entityType, entityName, factKey, priorValue) {
  const base = questionForFact(entityType, entityName, factKey);
  const knownPart = priorValue
    ? `We noted "${priorValue}" for ${entityName}'s ${factLabel(factKey)}, but weren't fully sure. `
    : `We have an unconfirmed note about ${entityName}'s ${factLabel(factKey)}. `;
  return `${knownPart}${base}`;
}

// Short-lived signed URLs are generated at read time, never persisted -
// visual_knowledge only stores the storage path. Keeps the bucket private
// while still letting any connected client view the image right now.
async function signImageUrl(imagePath) {
  if (!imagePath) return null;
  const { data, error } = await supabase.storage
    .from(IMAGE_BUCKET)
    .createSignedUrl(imagePath, SIGNED_URL_TTL);
  if (error) {
    console.error("Failed to sign image URL (ignored):", error);
    return null;
  }
  return data.signedUrl;
}

// Attaches short-lived signed URLs to any image-bearing metadata right
// before an entry is handed back to the client - never stored in the DB.
async function withImageUrls(entry) {
  if (!entry?.metadata) return entry;
  const meta = entry.metadata;

  if (meta.imagePath) {
    meta.imageUrl = await signImageUrl(meta.imagePath);
  }

  if (Array.isArray(meta.images)) {
    meta.images = await Promise.all(
      meta.images.map(async (img) => ({ ...img, url: await signImageUrl(img.imagePath) })),
    );
  }

  return { ...entry, metadata: meta };
}

// The question engine decides a picture is useful only when it directly
// helps confirm identification/terminology - text is the default for
// everything else, per "do not require an image for every question".
async function visualQuestionForFact(entityId, entityName, factKey) {
  const { data: candidates } = await supabase
    .from("visual_knowledge")
    .select("id, image_path, approval_status")
    .eq("entity_id", entityId)
    .eq("fact_key", factKey)
    .neq("approval_status", "rejected")
    .order("created_at", { ascending: false })
    .limit(5);

  if (candidates && candidates.length >= 2) {
    return {
      question: `Which of these matches how Tykel normally refers to "${entityName}"?`,
      metadata: {
        kind: "multi_image_choice",
        images: candidates.map((c) => ({ id: c.id, imagePath: c.image_path })),
      },
    };
  }

  if (candidates && candidates.length === 1) {
    return {
      question: `Is this the hardware you normally refer to as "${entityName}"?`,
      metadata: { kind: "image_confirm", imageId: candidates[0].id, imagePath: candidates[0].image_path },
    };
  }

  return {
    question: `Can you upload a photo of the "${entityName}" you're referring to?`,
    metadata: { kind: "image_upload" },
  };
}

async function seedDefaultFacts(entityId, entityType, skipKeys = []) {
  const keys = DEFAULT_FACTS[entityType] || [];
  const rows = keys
    .filter((k) => !skipKeys.includes(k))
    .map((factKey) => ({ entity_id: entityId, fact_key: factKey }));
  if (rows.length === 0) return;

  await supabase
    .from("knowledge_facts")
    .upsert(rows, { onConflict: "entity_id,fact_key", ignoreDuplicates: true });
}

async function findOrCreateEntity(entityType, name, parentName) {
  let parentId = null;
  if (parentName) {
    const { data: parent } = await supabase
      .from("knowledge_entities")
      .select("id")
      .ilike("name", parentName)
      .limit(1)
      .maybeSingle();
    parentId = parent?.id || null;
  }

  const { data: existing } = await supabase
    .from("knowledge_entities")
    .select("id")
    .eq("entity_type", entityType)
    .ilike("name", name)
    .maybeSingle();

  if (existing) return { id: existing.id, isNew: false };

  const { data: created, error } = await supabase
    .from("knowledge_entities")
    .insert({ entity_type: entityType, name, parent_id: parentId })
    .select("id")
    .single();

  if (error) throw error;
  return { id: created.id, isNew: true };
}

// Scores every open gap deterministically: fact importance + how many other
// entities depend on this one (connectivity) - revisits (uncertain) rank
// slightly below fresh gaps so new ground is covered first.
async function scoreCandidates(candidates) {
  const entityIds = [...new Set(candidates.map((c) => c.entityId))];
  const { data: children } = entityIds.length
    ? await supabase
      .from("knowledge_entities")
      .select("parent_id")
      .in("parent_id", entityIds)
    : { data: [] };

  const childCount = {};
  for (const row of children || []) {
    childCount[row.parent_id] = (childCount[row.parent_id] || 0) + 1;
  }

  return candidates
    .map((c) => {
      let score = FACT_WEIGHTS[c.factKey] ?? DEFAULT_WEIGHT;
      score += (childCount[c.entityId] || 0) * 2;
      if (c.status === "uncertain") score -= 3;
      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score);
}

// AI is only consulted to break a genuine tie among the top-scored
// candidates - it never answers or invents facts, only orders questions.
async function aiPickBestCandidate(candidates) {
  const compact = candidates.map((c, i) => ({
    index: i,
    entity: c.entityName,
    entityType: c.entityType,
    missingFact: factLabel(c.factKey),
  }));

  const prompt = `TYK is deciding which single knowledge gap to ask about next for a commercial door company.

Candidate gaps (compact list, equally scored by rules so far):
${JSON.stringify(compact)}

Pick the ONE candidate whose answer would unlock the most future knowledge or is most useful to ask right now.
Respond with ONLY the index number, nothing else.`;

  try {
    const { answer } = await generateAnswer(prompt);
    const index = parseInt(answer.trim().match(/\d+/)?.[0] ?? "", 10);
    if (Number.isInteger(index) && candidates[index]) return candidates[index];
  } catch (err) {
    console.error("AI tie-break failed (using top-scored candidate):", err);
  }
  return null;
}

// Picks the most useful open gap - prioritizing high-value, well-connected
// facts over arbitrary rotation, and revisiting uncertain facts with an
// explanation rather than silently re-asking.
async function pickCoverageGap(excludedFactIds = []) {
  const { data } = await supabase
    .from("knowledge_facts")
    .select(
      "id, fact_key, status, fact_value, entity_id, updated_at, knowledge_entities(name, entity_type)",
    )
    .in("status", ["missing", "uncertain"])
    .order("updated_at", { ascending: false })
    .limit(20);

  if (!data?.length) return null;

  const candidates = data.map((d) => ({
    factId: d.id,
    factKey: d.fact_key,
    status: d.status,
    factValue: d.fact_value,
    entityId: d.entity_id,
    entityName: d.knowledge_entities.name,
    entityType: d.knowledge_entities.entity_type,
  })).filter((candidate) => !excludedFactIds.includes(candidate.factId));

  if (!candidates.length) return null;

  const scored = await scoreCandidates(candidates);
  let chosen = scored[0];

  if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) <= 1) {
    const picked = await aiPickBestCandidate(scored.slice(0, 5));
    if (picked) chosen = picked;
  }

  // Image-based facts pick their own question type (confirm/choose/upload)
  // based on what visual evidence already exists - text is never forced.
  if (IMAGE_FACT_KEYS.has(chosen.factKey) && chosen.status !== "uncertain") {
    const visual = await visualQuestionForFact(chosen.entityId, chosen.entityName, chosen.factKey);
    return {
      question: visual.question,
      metadata: {
        ...visual.metadata,
        entityId: chosen.entityId,
        entityType: chosen.entityType,
        entityName: chosen.entityName,
        factId: chosen.factId,
        factKey: chosen.factKey,
      },
    };
  }

  const question = chosen.status === "uncertain"
    ? revisitQuestionForFact(
      chosen.entityType,
      chosen.entityName,
      chosen.factKey,
      chosen.factValue,
    )
    : questionForFact(chosen.entityType, chosen.entityName, chosen.factKey);

  return {
    question,
    metadata: {
      kind: "fact",
      entityId: chosen.entityId,
      entityType: chosen.entityType,
      entityName: chosen.entityName,
      factId: chosen.factId,
      factKey: chosen.factKey,
    },
  };
}

async function generateOpenQuestion() {
  const { data: recent } = await supabase
    .from("learning_entries")
    .select("question")
    .order("created_at", { ascending: false })
    .limit(15);

  const askedBefore = (recent || []).map((r) => `- ${r.question}`).join("\n");

  const prompt = `You are TYK, an AI learning about a commercial door company called Tykel (hollow metal doors/frames, hardware, exit devices, closers, access control, installation practices, company procedures, terminology, suppliers, and manufacturers).

Generate exactly ONE short, specific question to ask an employee to discover a NEW supplier, manufacturer, product, or company procedure that TYK doesn't know about yet. Prefer broad discovery questions over ones already asked.

Questions already asked (do not repeat these or close variations):
${askedBefore || "(none yet)"}

Respond with ONLY the question text, no numbering, no quotes, no extra commentary.`;

  try {
    const { answer } = await generateAnswer(prompt);
    return answer.trim().replace(/^["'\d.\s]+|["'\s]+$/g, "");
  } catch (err) {
    console.error("Open question generation failed (using fallback):", err);
    return "What's something about how Tykel operates that you think TYK should know?";
  }
}

// Zero-AI sentiment check for yes/no document questions - keeps the upload
// flow working even during an AI outage.
function detectYesNo(text) {
  const t = text.toLowerCase();
  if (/\b(yes|yeah|yep|we have|already have|got (it|them)|on file)\b/.test(t)) {
    return "yes";
  }
  if (/\b(no|nope|we don'?t|do not have|don'?t have|not yet)\b/.test(t)) {
    return "no";
  }
  return null;
}

function detectUncertainty(text) {
  return /\b(not sure|i think|maybe|possibly|not certain|might be|i believe|not 100%)\b/i
    .test(text);
}

// One AI call per answer, used ONLY to discover brand-new entities mentioned
// in passing (e.g. a manufacturer name dropped while answering a different
// question) - the targeted fact itself is already recorded deterministically.
async function extractKnowledge(question, answerText) {
  const prompt = `A Tykel employee (commercial door company) just answered a knowledge-gathering question.

Question: ${question}
Answer: ${answerText}

Extract any entities mentioned and respond with ONLY JSON (no markdown) in this exact shape:
{
  "entities": [{"type": "supplier|manufacturer|product|product_family|procedure|document|website|process|terminology", "name": string, "parent_name": string or null}],
  "facts": [{"entity_name": string, "fact_key": string (snake_case, short), "fact_value": string}]
}

Only include entities/facts clearly stated in the answer. Do not invent information.`;

  try {
    const { answer } = await generateAnswer(prompt);
    const match = answer.match(/\{[\s\S]*\}/);
    if (!match) return { entities: [], facts: [] };
    const parsed = JSON.parse(match[0]);
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
    };
  } catch (err) {
    console.error("Knowledge extraction failed (ignored):", err);
    return { entities: [], facts: [] };
  }
}

// Deterministic keyword -> connected source mapping, mirrors ask-tyk's.
const CONNECTED_SOURCE_TOPICS = [
  { pattern: /\bnfpa\b|fire code|fire-rated|fire rated/i, provider: "nfpa_link" },
];

// Notices when a relevant topic (e.g. fire code/NFPA) has come up but the
// authoritative Connected Source for it isn't connected yet - zero AI needed.
async function findConnectedSourceGap() {
  for (const topic of CONNECTED_SOURCE_TOPICS) {
    const { data: source } = await supabase
      .from("connected_sources")
      .select("name, status")
      .eq("provider", topic.provider)
      .maybeSingle();

    if (!source || source.status === "connected") continue;

    const { data: keywordMentions } = await supabase
      .from("learning_entries")
      .select("question, answer")
      .limit(50)
      .order("created_at", { ascending: false });

    const hasMention = (keywordMentions || []).some((row) =>
      topic.pattern.test(row.question || "") || topic.pattern.test(row.answer || "")
    );

    if (!hasMention) continue;

    const question =
      `We've talked about NFPA/fire code topics, but TYK doesn't have access to ${source.name} yet. Would you like to connect it so I can use the current, authoritative source?`;

    const { data: alreadyAsked } = await supabase
      .from("learning_entries")
      .select("id")
      .eq("question", question)
      .limit(1);

    if (alreadyAsked?.length) continue;

    return { question, metadata: { kind: "connected_source", provider: topic.provider } };
  }
  return null;
}

async function createQuestionEntry(question, metadata) {
  const { data: created, error } = await supabase
    .from("learning_entries")
    .insert({ question, metadata: metadata || null })
    .select()
    .single();
  if (error) throw error;
  return created;
}

async function saveExternalTeachDiscovery(gap, research) {
  await saveWebResearch(research);
  const sourceLines = research.sources
    .map((source) => `- ${source.title} (${source.url})`)
    .join("\n");
  const answer = research.ambiguity
    ? `${research.answer}\n\nEvidence note: ${research.ambiguity}\n\nSources:\n${sourceLines}`
    : `${research.answer}\n\nSources:\n${sourceLines}`;

  const { data, error } = await supabase
    .from("learning_entries")
    .insert({
      question: gap.question,
      answer,
      status: "answered",
      answered_at: new Date().toISOString(),
      metadata: {
        ...gap.metadata,
        kind: "external_research",
        knowledgeState: "SOURCE_BACKED",
        sources: research.sources,
        confidence: research.confidence,
      },
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function nextQuestionEntryRaw() {
  const { data: pending } = await supabase
    .from("learning_entries")
    .select("id, question, metadata, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pending) return pending;

  const sourceGap = await findConnectedSourceGap();
  if (sourceGap) return createQuestionEntry(sourceGap.question, sourceGap.metadata);

  const excludedFactIds = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const gap = await pickCoverageGap(excludedFactIds);
    if (!gap) break;
    excludedFactIds.push(gap.metadata.factId);

    // External facts are researched before TYK asks an employee. Company-
    // specific procedures and visual confirmations still require a human.
    if (gap.metadata.kind === "fact" && !IMAGE_FACT_KEYS.has(gap.metadata.factKey)) {
      try {
        const research = await researchWeb(gap.question);
        if (research) {
          await saveExternalTeachDiscovery(gap, research);
          continue;
        }
      } catch (err) {
        console.error("Teach TYK web research failed (asking human instead):", err);
      }
    }

    return createQuestionEntry(gap.question, gap.metadata);
  }

  const question = await generateOpenQuestion();
  return createQuestionEntry(question, { kind: "open" });
}

// Every caller goes through this wrapper so image metadata always arrives
// with a fresh, short-lived signed URL - never a stale/expired one.
async function nextQuestionEntry() {
  return withImageUrls(await nextQuestionEntryRaw());
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
        .from("learning_entries")
        .select("id, topic, question, answer, status, created_at, answered_at")
        .order("created_at", { ascending: false });

      if (error) return json({ error: error.message }, 500);
      return json({ entries: data || [] });
    }

    if (action === "coverage") {
      const { data: entities, error } = await supabase
        .from("knowledge_entities")
        .select(
          "id, entity_type, name, knowledge_facts(fact_key, status, fact_value)",
        )
        .order("updated_at", { ascending: false })
        .limit(50);

      if (error) return json({ error: error.message }, 500);
      return json({ entities: entities || [] });
    }

    if (action === "next-question") {
      if (!(await hasPermission(body, "can_teach_tyk"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const entry = await nextQuestionEntry();
      return json({ entry });
    }

    if (action === "answer") {
      if (!(await hasPermission(body, "can_teach_tyk"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { entry_id, answer } = body;
      if (!entry_id || !answer?.trim()) {
        return json({ error: "entry_id and answer are required" }, 400);
      }
      const answerText = answer.trim();

      const { data: entry, error: fetchError } = await supabase
        .from("learning_entries")
        .select("question, metadata")
        .eq("id", entry_id)
        .single();
      if (fetchError) return json({ error: fetchError.message }, 500);

      const { error: updateError } = await supabase
        .from("learning_entries")
        .update({
          answer: answerText,
          status: "answered",
          answered_at: new Date().toISOString(),
        })
        .eq("id", entry_id);

      if (updateError) return json({ error: updateError.message }, 500);

      const meta = entry.metadata || {};
      let learned = null;
      let forcedNext = null;

      // The question already told us exactly which fact it targets, so
      // recording the core answer needs zero AI - only bonus entity
      // discovery below uses a model call.
      if (meta.kind === "fact") {
        const isDocumentFact = DOCUMENT_FACT_KEYS.has(meta.factKey);

        if (isDocumentFact) {
          const yesNo = detectYesNo(answerText);
          if (yesNo === "yes") {
            await supabase.from("knowledge_facts").update({
              status: "confirmed",
              fact_value: "Available - not yet uploaded to TYK",
              source_type: "user_confirmed",
              learning_entry_id: entry_id,
              updated_at: new Date().toISOString(),
            }).eq("id", meta.factId);

            forcedNext = await createQuestionEntry(
              `Great - please upload ${meta.entityName}'s ${factLabel(meta.factKey)} so I can connect it permanently.`,
              { ...meta, kind: "upload_prompt" },
            );
          } else if (yesNo === "no") {
            await supabase.from("knowledge_facts").update({
              status: "missing",
              fact_value: "Not currently available",
              updated_at: new Date().toISOString(),
            }).eq("id", meta.factId);

            forcedNext = await createQuestionEntry(
              `Where can TYK find ${meta.entityName}'s ${factLabel(meta.factKey)} - a website, supplier portal, or another source?`,
              { ...meta, kind: "fact", factKey: "website" },
            );
          } else {
            await supabase.from("knowledge_facts").update({
              status: detectUncertainty(answerText) ? "uncertain" : "confirmed",
              fact_value: answerText.slice(0, 500),
              source_type: "user_confirmed",
              learning_entry_id: entry_id,
              updated_at: new Date().toISOString(),
            }).eq("id", meta.factId);
          }
        } else {
          await supabase.from("knowledge_facts").update({
            status: detectUncertainty(answerText) ? "uncertain" : "confirmed",
            fact_value: answerText.slice(0, 500),
            source_type: "user_confirmed",
            learning_entry_id: entry_id,
            updated_at: new Date().toISOString(),
          }).eq("id", meta.factId);
        }

        learned = { entityName: meta.entityName, factKey: meta.factKey };
      }

      // Confirming (or rejecting) a photo TYK already had on file for this
      // entity - zero AI needed, same yes/no detector as the document flow.
      if (meta.kind === "image_confirm") {
        const yesNo = detectYesNo(answerText);
        if (yesNo === "yes") {
          await supabase.from("visual_knowledge").update({
            approval_status: "confirmed",
            confidence: "confirmed",
            answer: answerText,
            updated_at: new Date().toISOString(),
          }).eq("id", meta.imageId);

          await supabase.from("knowledge_facts").update({
            status: "confirmed",
            fact_value: meta.entityName,
            linked_image_id: meta.imageId,
            source_type: "user_confirmed",
            learning_entry_id: entry_id,
            updated_at: new Date().toISOString(),
          }).eq("id", meta.factId);
        } else {
          // Wrong match - this image doesn't represent the entity after all;
          // ask for the real one instead of silently leaving the fact stuck.
          await supabase.from("visual_knowledge").update({
            approval_status: "rejected",
            updated_at: new Date().toISOString(),
          }).eq("id", meta.imageId);

          forcedNext = await createQuestionEntry(
            `Can you upload a photo of the "${meta.entityName}" you're referring to?`,
            { ...meta, kind: "image_upload" },
          );
        }

        learned = { entityName: meta.entityName, factKey: meta.factKey };
      }

      // Bonus discovery: catch any NEW entities/facts mentioned in passing,
      // regardless of question kind (e.g. a manufacturer name dropped while
      // answering a supplier question).
      const { entities, facts } = await extractKnowledge(
        entry.question,
        answerText,
      );

      const entityIdByName = {};
      for (const e of entities) {
        if (!e?.name) continue;
        try {
          const { id, isNew } = await findOrCreateEntity(
            e.type,
            e.name,
            e.parent_name,
          );
          entityIdByName[e.name.toLowerCase()] = id;
          if (isNew) await seedDefaultFacts(id, e.type);
          if (!learned) learned = { entityName: e.name, factKey: e.type };
        } catch (err) {
          console.error("Failed to save entity (ignored):", err);
        }
      }

      for (const f of facts) {
        const entityId = entityIdByName[f.entity_name?.toLowerCase()];
        if (!entityId || !f.fact_key) continue;
        try {
          await supabase.from("knowledge_facts").upsert({
            entity_id: entityId,
            fact_key: f.fact_key,
            fact_value: f.fact_value || null,
            status: "confirmed",
            source_type: "user_confirmed",
            learning_entry_id: entry_id,
            updated_at: new Date().toISOString(),
          }, { onConflict: "entity_id,fact_key" });
        } catch (err) {
          console.error("Failed to save fact (ignored):", err);
        }
      }

      // Feed the SAME knowledge system the main chat uses - a human-confirmed
      // answer is trustworthy enough to reuse immediately, zero AI next time.
      try {
        const embedding = await embedText(entry.question);
        await saveLearnedAnswer({
          question: entry.question,
          normalizedQuestion: entry.question.trim().toLowerCase(),
          intent: "teach_tyk_confirmed",
          answer: answerText,
          embedding,
          sourceDocumentIds: [],
          searchTerms: [],
        });
        await supabase
          .from("learned_answers")
          .update({ status: "approved" })
          .eq("question", entry.question)
          .eq("answer", answerText);
      } catch (err) {
        console.error("Failed to save learned answer (ignored):", err);
      }

      const nextEntry = forcedNext ? await withImageUrls(forcedNext) : await nextQuestionEntry();
      return json({ entry: nextEntry, learned });
    }

    if (action === "attach-document") {
      if (!(await hasPermission(body, "can_teach_tyk"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { entry_id, entity_id, fact_key, document_id, document_name } = body;
      if (!entity_id || !fact_key || !document_id) {
        return json(
          { error: "entity_id, fact_key, and document_id are required" },
          400,
        );
      }

      await supabase.from("knowledge_facts").update({
        status: "confirmed",
        fact_value: document_name || "Uploaded",
        linked_document_id: document_id,
        source_type: "document",
        updated_at: new Date().toISOString(),
      }).eq("entity_id", entity_id).eq("fact_key", fact_key);

      if (entry_id) {
        await supabase.from("learning_entries").update({
          answer: `Uploaded: ${document_name || document_id}`,
          status: "answered",
          answered_at: new Date().toISOString(),
        }).eq("id", entry_id);
      }

      const nextEntry = await nextQuestionEntry();
      return json({ entry: nextEntry });
    }

    // Multimodal upload flow (mirrors document-manager's request-upload):
    // signed URL to a private bucket, browser PUTs directly, then
    // confirm-image-upload records the resulting knowledge.
    if (action === "request-image-upload") {
      if (!(await hasPermission(body, "can_teach_tyk"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { file_name, file_type } = body;
      if (!file_name) return json({ error: "file_name is required" }, 400);

      const path = `${crypto.randomUUID()}-${file_name.replace(/[^\w.-]/g, "_")}`;
      const { data: signed, error } = await supabase.storage
        .from(IMAGE_BUCKET)
        .createSignedUploadUrl(path);

      if (error) return json({ error: error.message }, 500);
      return json({ uploadUrl: signed.signedUrl, token: signed.token, path, fileType: file_type });
    }

    // A picture is only ever treated as company knowledge once someone
    // explicitly confirms it belongs to this entity - approval_status starts
    // 'pending' here and only becomes 'confirmed' via image_confirm's yes
    // branch (or immediately if this call already knows the answer, e.g. the
    // very first upload for a brand-new visual reference).
    if (action === "confirm-image-upload") {
      if (!(await hasPermission(body, "can_teach_tyk"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { entry_id, entity_id, fact_key, entity_name, image_path } = body;
      if (!entity_id || !fact_key || !image_path) {
        return json(
          { error: "entity_id, fact_key, and image_path are required" },
          400,
        );
      }
      const identity = await loadIdentity(body);

      const { data: image, error: imageError } = await supabase
        .from("visual_knowledge")
        .insert({
          entity_id,
          fact_key,
          image_path,
          product: entity_name || null,
          source: "teach_tyk",
          owner_type: identity?.type || null,
          owner_id: identity?.id || null,
          scope: "company",
          confidence: "unverified",
          approval_status: "pending",
        })
        .select()
        .single();

      if (imageError) return json({ error: imageError.message }, 500);

      await supabase.from("knowledge_facts").update({
        status: "confirmed",
        fact_value: entity_name || "Uploaded photo",
        linked_image_id: image.id,
        source_type: "user_confirmed",
        learning_entry_id: entry_id || null,
        updated_at: new Date().toISOString(),
      }).eq("entity_id", entity_id).eq("fact_key", fact_key);

      if (entry_id) {
        await supabase.from("learning_entries").update({
          answer: "Uploaded a reference photo",
          status: "answered",
          answered_at: new Date().toISOString(),
        }).eq("id", entry_id);
      }

      const nextEntry = await nextQuestionEntry();
      return json({ entry: nextEntry, learned: { entityName: entity_name, factKey: fact_key } });
    }

    // Picking the correct image out of several candidates - the chosen one
    // becomes company knowledge, the rest are rejected so they stop being
    // offered as candidates for this fact again.
    if (action === "choose-image") {
      if (!(await hasPermission(body, "can_teach_tyk"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { entry_id, entity_id, fact_key, entity_name, chosen_image_id, image_ids } = body;
      if (!entity_id || !fact_key || !chosen_image_id) {
        return json(
          { error: "entity_id, fact_key, and chosen_image_id are required" },
          400,
        );
      }

      await supabase.from("visual_knowledge")
        .update({ approval_status: "confirmed", confidence: "confirmed", updated_at: new Date().toISOString() })
        .eq("id", chosen_image_id);

      const otherIds = (image_ids || []).filter((id) => id !== chosen_image_id);
      if (otherIds.length) {
        await supabase.from("visual_knowledge")
          .update({ approval_status: "rejected", updated_at: new Date().toISOString() })
          .in("id", otherIds);
      }

      await supabase.from("knowledge_facts").update({
        status: "confirmed",
        fact_value: entity_name || "Confirmed by selection",
        linked_image_id: chosen_image_id,
        source_type: "user_confirmed",
        learning_entry_id: entry_id || null,
        updated_at: new Date().toISOString(),
      }).eq("entity_id", entity_id).eq("fact_key", fact_key);

      if (entry_id) {
        await supabase.from("learning_entries").update({
          answer: "Selected the matching image",
          status: "answered",
          answered_at: new Date().toISOString(),
        }).eq("id", entry_id);
      }

      const nextEntry = await nextQuestionEntry();
      return json({ entry: nextEntry, learned: { entityName: entity_name, factKey: fact_key } });
    }

    if (action === "skip") {
      if (!(await hasPermission(body, "can_teach_tyk"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { entry_id } = body;
      if (!entry_id) return json({ error: "entry_id is required" }, 400);

      await supabase
        .from("learning_entries")
        .update({ status: "skipped" })
        .eq("id", entry_id);

      const nextEntry = await nextQuestionEntry();
      return json({ entry: nextEntry });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("teach-tyk error:", err);
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
