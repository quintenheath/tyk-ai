// Document lifecycle: request-upload -> confirm/process -> list -> delete.
// Runs with the service role so it can write to private storage and DB
// tables that anon has zero RLS access to.
import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { embedTexts } from "../_shared/embeddings.ts";
import { generateAnswer } from "../_shared/ai-router.ts";
import { hasPermission } from "../_shared/permissions.ts";
import { loadIdentity } from "../_shared/permissions.ts";
import { extractText, getDocumentProxy } from "npm:unpdf@0.11.0";
import JSZip from "npm:jszip@3.10.1";

const BUCKET = "tyk-documents";
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const EXPORT_TTL_SECONDS = 600;

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

async function requireAdmin(body) {
  const identity = await loadIdentity(body);
  return Boolean(identity?.type === "user" && identity.role === "admin");
}

async function canDownload(body) {
  return (await hasPermission(body, "can_download_documents")) ||
    (await hasPermission(body, "can_upload_documents"));
}

function safeFileName(name, fallback) {
  const clean = (name || fallback).replace(/[^\w. -]/g, "_").trim();
  return clean || fallback;
}

function csvValue(value) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  if (!rows?.length) return "";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    columns.map(csvValue).join(","),
    ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(",")),
  ].join("\n");
}

async function signedExport(bytes, fileName, contentType) {
  const path = `_exports/${crypto.randomUUID()}-${safeFileName(fileName, "export.zip")}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(
    path,
    bytes,
    { contentType, upsert: false },
  );
  if (uploadError) throw uploadError;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, EXPORT_TTL_SECONDS, { download: fileName });
  if (error) throw error;
  return { url: data.signedUrl, expiresIn: EXPORT_TTL_SECONDS };
}

async function loadKnowledgeExport() {
  const [documents, chunks, sources, entities, facts, learned, queue, log, conflicts, visual] = await Promise.all([
    supabase.from("documents").select("*").order("created_at", { ascending: true }),
    supabase.from("document_chunks").select("*").order("document_id", { ascending: true }).order("chunk_index", { ascending: true }),
    supabase.from("web_sources").select("*").order("retrieved_at", { ascending: true }),
    supabase.from("knowledge_entities").select("*"),
    supabase.from("knowledge_facts").select("*"),
    supabase.from("learned_answers").select("id, question, normalized_question, intent, answer, status, source_document_ids, search_terms, created_at, last_used_at, reuse_count"),
    supabase.from("research_queue").select("*"),
    supabase.from("research_log").select("*"),
    supabase.from("web_source_conflicts").select("*"),
    supabase.from("visual_knowledge").select("*"),
  ]);
  const result = (response) => response.data || [];
  return {
    export_version: "1.0",
    exported_at: new Date().toISOString(),
    documents: result(documents),
    document_chunks: result(chunks),
    sources: result(sources),
    entities: result(entities),
    facts: result(facts),
    learned_answers: result(learned),
    research_tasks: result(queue),
    research_history: result(log),
    conflicts: result(conflicts),
    visual_knowledge: result(visual),
  };
}

async function createKnowledgeExport() {
  const knowledge = await loadKnowledgeExport();
  const zip = new JSZip();
  zip.file("Knowledge/knowledge.json", JSON.stringify(knowledge, null, 2));
  zip.file("Knowledge/facts.csv", toCsv(knowledge.facts));
  zip.file("Knowledge/entities.csv", toCsv(knowledge.entities));
  zip.file("Knowledge/sources.csv", toCsv(knowledge.sources));
  zip.file("Research/research_tasks.csv", toCsv(knowledge.research_tasks));
  zip.file("Research/research_history.csv", toCsv(knowledge.research_history));
  zip.file("Research/conflicts.csv", toCsv(knowledge.conflicts));
  return { knowledge, zip };
}

// Splits page text into overlapping chunks so context isn't cut off mid-idea.
function chunkPageText(pageText) {
  const clean = pageText.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    chunks.push(clean.slice(start, end));
    if (end === clean.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

// One AI call per document (not per question) to identify what it actually
// is, so the user never has to classify anything themselves. Best-effort:
// a failure here must never make the document unsearchable.
async function classifyDocument(sampleText) {
  const prompt = `Analyze this excerpt from a commercial door/hardware industry document and identify its metadata.

Respond with ONLY a JSON object (no markdown, no commentary) with these exact keys:
{
  "manufacturer": string or null,
  "product": string or null,
  "product_family": string or null,
  "document_type": string or null (e.g. "installation manual", "catalog", "specification", "template", "brochure", "fire code", "company procedure"),
  "topics": string[] (up to 6 short topic keywords),
  "part_numbers": string[] (any part numbers found, up to 10),
  "model_numbers": string[] (any model/series numbers found, up to 10),
  "document_date": string or null (date or version if stated)
}

Use null or empty arrays for anything not clearly identifiable. Do not guess.

Document excerpt:
${sampleText}`;

  try {
    const { answer } = await generateAnswer(prompt);
    const jsonMatch = answer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error("Document classification failed (ignored):", err);
    return null;
  }
}

async function processDocument(documentId) {
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("id, name, file_path, file_type")
    .eq("id", documentId)
    .single();

  if (docError || !doc) throw new Error("Document not found.");

  await supabase
    .from("documents")
    .update({ status: "processing", error_message: null })
    .eq("id", documentId);

  const { data: file, error: downloadError } = await supabase.storage
    .from(BUCKET)
    .download(doc.file_path);

  if (downloadError) throw downloadError;

  const isPdf = (doc.file_type || "").includes("pdf") ||
    doc.file_path.toLowerCase().endsWith(".pdf");

  let pageTexts = [];
  if (isPdf) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const pdf = await getDocumentProxy(buffer);
    const { text } = await extractText(pdf, { mergePages: false });
    pageTexts = Array.isArray(text) ? text : [text];
  } else {
    pageTexts = [await file.text()];
  }

  const records = [];
  pageTexts.forEach((pageText, pageIndex) => {
    for (const chunk of chunkPageText(pageText)) {
      records.push({ pageNumber: pageIndex + 1, content: chunk });
    }
  });

  if (records.length === 0) {
    await supabase
      .from("documents")
      .update({
        status: "error",
        error_message: "No extractable text was found in this document.",
      })
      .eq("id", documentId);
    throw new Error("No extractable text was found in this document.");
  }

  const embeddings = await embedTexts(records.map((r) => r.content));

  const rows = records.map((record, index) => ({
    document_id: documentId,
    chunk_index: index,
    page_number: record.pageNumber,
    content: record.content,
    embedding: embeddings[index],
  }));

  // Insert in batches to stay well under request size limits.
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error: insertError } = await supabase
      .from("document_chunks")
      .insert(rows.slice(i, i + BATCH));
    if (insertError) throw insertError;
  }

  await supabase
    .from("documents")
    .update({ status: "indexed", chunk_count: rows.length })
    .eq("id", documentId);

  // Auto-classify from the first couple pages - never blocks indexing.
  const sampleText = records.slice(0, 4).map((r) => r.content).join("\n")
    .slice(0, 4000);
  const metadata = await classifyDocument(sampleText);
  if (metadata) {
    await supabase
      .from("documents")
      .update({
        manufacturer: metadata.manufacturer || null,
        product: metadata.product || null,
        product_family: metadata.product_family || null,
        document_type: metadata.document_type || null,
        topics: metadata.topics?.length ? metadata.topics : null,
        part_numbers: metadata.part_numbers?.length
          ? metadata.part_numbers
          : null,
        model_numbers: metadata.model_numbers?.length
          ? metadata.model_numbers
          : null,
        document_date: metadata.document_date || null,
        category: metadata.document_type || null,
        auto_metadata: metadata,
      })
      .eq("id", documentId);
  }

  return { chunkCount: rows.length };
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
        .from("documents")
        .select(
          "id, name, description, file_type, file_size, category, manufacturer, product, product_family, document_type, topics, part_numbers, model_numbers, document_date, status, error_message, chunk_count, created_at",
        )
        .order("created_at", { ascending: false });

      if (error) return json({ error: error.message }, 500);
      return json({ documents: (data || []).map((document) => ({
        ...document,
        has_file: Boolean(document.file_path),
        file_path: undefined,
      })) });
    }

    // Deterministic ILIKE search across the shared company document list -
    // zero AI, matches the "prefer deterministic answers" philosophy used
    // everywhere else in TYK.
    if (action === "search") {
      const query = (body.query || "").trim();
      if (!query) return json({ documents: [] });

      const { data, error } = await supabase
        .from("documents")
        .select("id, name, manufacturer, product, document_type")
        .or(
          `name.ilike.%${query}%,manufacturer.ilike.%${query}%,product.ilike.%${query}%,document_type.ilike.%${query}%`,
        )
        .limit(15);

      if (error) return json({ error: error.message }, 500);
      return json({ documents: data || [] });
    }

    if (action === "download") {
      if (!(await canDownload(body))) return json({ error: "Forbidden" }, 403);
      const { document_id } = body;
      const { data: doc, error } = await supabase
        .from("documents")
        .select("id, name, file_path")
        .eq("id", document_id)
        .single();
      if (error || !doc?.file_path) return json({ error: "Document file not found." }, 404);

      const { data, error: signedError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(doc.file_path, EXPORT_TTL_SECONDS, {
          download: safeFileName(doc.name, "document.pdf"),
        });
      if (signedError) return json({ error: "Could not create a secure download." }, 500);
      return json({ url: data.signedUrl, expiresIn: EXPORT_TTL_SECONDS });
    }

    if (action === "download-all") {
      if (!(await canDownload(body))) return json({ error: "Forbidden" }, 403);
      const { data: docs, error } = await supabase
        .from("documents")
        .select("id, name, file_path, file_type")
        .not("file_path", "is", null)
        .order("created_at", { ascending: true });
      if (error) return json({ error: "Could not load documents." }, 500);

      const zip = new JSZip();
      const names = new Set();
      for (const doc of docs || []) {
        const { data: file, error: downloadError } = await supabase.storage.from(BUCKET).download(doc.file_path);
        if (downloadError || !file) continue;
        const original = safeFileName(doc.name, `document-${doc.id}.pdf`);
        const extension = doc.file_type?.includes("plain") && !original.includes(".") ? ".txt" : "";
        let fileName = `${original}${extension}`;
        let suffix = 2;
        while (names.has(fileName)) fileName = `${original} (${suffix++})${extension}`;
        names.add(fileName);
        zip.file(`Documents/${fileName}`, new Uint8Array(await file.arrayBuffer()));
      }
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return json({
        ...(await signedExport(bytes, "TYK-Documents.zip", "application/zip")),
      });
    }

    if (action === "export-knowledge") {
      if (!(await requireAdmin(body))) return json({ error: "Forbidden" }, 403);
      const { knowledge } = await createKnowledgeExport();
      const fileName = `TYK-Knowledge-${new Date().toISOString().slice(0, 10)}.json`;
      const bytes = new TextEncoder().encode(JSON.stringify(knowledge, null, 2));
      return json({
        ...(await signedExport(bytes, fileName, "application/json")),
      });
    }

    if (action === "export-everything") {
      if (!(await requireAdmin(body))) return json({ error: "Forbidden" }, 403);
      const { knowledge, zip } = await createKnowledgeExport();
      const docs = knowledge.documents.filter((doc) => doc.file_path);
      const names = new Set();
      for (const doc of docs) {
        const { data: file } = await supabase.storage.from(BUCKET).download(doc.file_path);
        if (!file) continue;
        const original = safeFileName(doc.name, `document-${doc.id}.pdf`);
        let fileName = original;
        let suffix = 2;
        while (names.has(fileName)) fileName = `${original} (${suffix++})`;
        names.add(fileName);
        zip.file(`Documents/${fileName}`, new Uint8Array(await file.arrayBuffer()));
      }
      zip.file("Metadata/export-manifest.json", JSON.stringify({
        export_version: knowledge.export_version,
        exported_at: knowledge.exported_at,
        documents: docs.length,
        knowledge_records: knowledge.facts.length + knowledge.learned_answers.length,
        sources: knowledge.sources.length,
        research_tasks: knowledge.research_tasks.length,
      }, null, 2));
      zip.file("Metadata/README.txt", "TYK full export. Original documents are in Documents/. Structured knowledge and research records are in Knowledge/ and Research/. Exported " + knowledge.exported_at + ".");
      const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      return json({
        ...(await signedExport(bytes, `TYK-Full-Export-${new Date().toISOString().slice(0, 10)}.zip`, "application/zip")),
      });
    }

    if (action === "request-upload") {
      if (!(await hasPermission(body, "can_upload_documents"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { name, fileType, fileSize, description } = body;
      if (!name?.trim()) return json({ error: "name is required" }, 400);

      const path = `${crypto.randomUUID()}-${name.replace(/[^\w.-]/g, "_")}`;

      const { data: doc, error: docError } = await supabase
        .from("documents")
        .insert({
          name,
          description: description || null,
          file_path: path,
          file_type: fileType || null,
          file_size: fileSize || null,
          status: "uploading",
        })
        .select()
        .single();

      if (docError) return json({ error: docError.message }, 500);

      const { data: signed, error: signedError } = await supabase.storage
        .from(BUCKET)
        .createSignedUploadUrl(path);

      if (signedError) return json({ error: signedError.message }, 500);

      return json({
        document: doc,
        uploadUrl: signed.signedUrl,
        token: signed.token,
        path,
      });
    }

    if (action === "process") {
      if (!(await hasPermission(body, "can_upload_documents"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { document_id } = body;
      if (!document_id) {
        return json({ error: "document_id is required" }, 400);
      }

      try {
        const result = await processDocument(document_id);
        return json({ ok: true, ...result });
      } catch (err) {
        await supabase
          .from("documents")
          .update({ status: "error", error_message: err.message })
          .eq("id", document_id);
        return json({ error: err.message }, 500);
      }
    }

    if (action === "delete") {
      if (!(await hasPermission(body, "can_manage_documents"))) {
        return json({ error: "Forbidden" }, 403);
      }
      const { document_id } = body;
      if (!document_id) {
        return json({ error: "document_id is required" }, 400);
      }

      const { data: doc } = await supabase
        .from("documents")
        .select("file_path")
        .eq("id", document_id)
        .single();

      if (doc?.file_path) {
        await supabase.storage.from(BUCKET).remove([doc.file_path]);
      }

      await supabase.from("document_chunks").delete().eq(
        "document_id",
        document_id,
      );
      const { error } = await supabase
        .from("documents")
        .delete()
        .eq("id", document_id);

      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    console.error("document-manager error:", err);
    return json({ error: err.message || "Unexpected error" }, 500);
  }
});
