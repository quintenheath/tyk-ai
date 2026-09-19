import { supabaseAdmin as supabase } from "../_shared/supabase-admin.ts";
import { loadIdentity } from "../_shared/permissions.ts";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import JSZip from "npm:jszip@3.10.1";

const BUCKET = "tyk-documents";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function xmlEscape(value) {
  return String(value || "").replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" }[character]));
}

function linesFromContent(title, content) {
  return [`TYK - ${title || "Generated document"}`, "", ...String(content || "").split(/\r?\n/).map((line) => line.slice(0, 180))];
}

async function createPdf(title, content) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage();
  let y = page.getHeight() - 48;
  for (const line of linesFromContent(title, content)) {
    if (y < 48) { page = pdf.addPage(); y = page.getHeight() - 48; }
    page.drawText(line, { x: 42, y, size: line.startsWith("TYK - ") ? 16 : 10, font });
    y -= line.startsWith("TYK - ") ? 24 : 14;
  }
  return { bytes: await pdf.save(), contentType: "application/pdf", extension: "pdf" };
}

async function createDocx(title, content) {
  const zip = new JSZip();
  const paragraphs = linesFromContent(title, content).map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`).join("");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`);
  return { bytes: await zip.generateAsync({ type: "uint8array" }), contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx" };
}

async function createXlsx(title, content) {
  const zip = new JSZip();
  const rows = linesFromContent(title, content).map((line) => `<row><c t="inlineStr"><is><t>${xmlEscape(line)}</t></is></c></row>`).join("");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="TYK Export" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`);
  return { bytes: await zip.generateAsync({ type: "uint8array" }), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    if (!await loadIdentity(body)) return json({ error: "A valid session token is required" }, 401);
    const format = String(body.format || "").toLowerCase();
    const title = String(body.title || "TYK export").slice(0, 120);
    const content = String(body.content || "").slice(0, 120000);
    if (!content.trim()) return json({ error: "Content is required" }, 400);

    let generated;
    if (format === "pdf") generated = await createPdf(title, content);
    else if (format === "docx") generated = await createDocx(title, content);
    else if (format === "xlsx") generated = await createXlsx(title, content);
    else if (format === "csv") generated = { bytes: new TextEncoder().encode(content), contentType: "text/csv", extension: "csv" };
    else return json({ error: "Unsupported document format" }, 400);

    const fileName = `${title.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "tyk-export"}.${generated.extension}`;
    const path = `_generated/${crypto.randomUUID()}-${fileName}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, generated.bytes, { contentType: generated.contentType, upsert: false });
    if (uploadError) return json({ error: "Could not save the generated file." }, 500);
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 600, { download: fileName });
    if (error) return json({ error: "Could not create a secure download." }, 500);
    return json({ url: data.signedUrl, fileName, format, expiresIn: 600 });
  } catch (error) {
    console.error("document-generator error:", error);
    return json({ error: "Could not create that file." }, 500);
  }
});