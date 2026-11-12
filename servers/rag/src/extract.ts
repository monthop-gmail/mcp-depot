import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { normalizeThaiPdf, pickBetterThaiExtract } from "./thai-normalize.js";

const TEXT_EXTS = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".html", ".htm", ".json", ".xml"]);
const MAX_PDF_TEXT = 64 * 1024 * 1024;

export type ExtractResult = { ok: true; text: string } | { ok: false; reason: string };

export function supportedExt(path: string): "text" | "pdf" | "skip" {
  const ext = extname(path).toLowerCase();
  return TEXT_EXTS.has(ext) ? "text" : ext === ".pdf" ? "pdf" : "skip";
}

/** Text of one document; PDF pages are separated by form feeds. Scanned pages without a text layer yield nothing (no OCR). */
export async function extractFile(path: string): Promise<ExtractResult> {
  const kind = supportedExt(path);
  if (kind === "skip") return { ok: false, reason: "unsupported extension" };
  if (kind === "pdf") return extractPdf(path);
  try {
    const buf = readFileSync(path);
    const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
    return { ok: true, text: normalizeThaiPdf(stripMarkup(path, text)) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** pdftotext (poppler-utils) in -layout and -raw modes; per page, keeps whichever detached fewer Thai marks. */
async function extractPdf(path: string): Promise<ExtractResult> {
  const [layout, raw] = await Promise.all([pdftotext(path, "-layout"), pdftotext(path, "-raw")]);
  if (!layout.ok && !raw.ok) return layout;
  const split = (r: ExtractResult) => (r.ok ? r.text.split("\f") : []);
  const a = split(layout);
  const b = split(raw);
  const pages = Array.from({ length: Math.max(a.length, b.length) }, (_, i) => pickBetterThaiExtract(a[i] ?? "", b[i] ?? ""));
  while (pages.length > 1 && !pages.at(-1)!.trim()) pages.pop();
  return { ok: true, text: pages.join("\f") };
}

function pdftotext(path: string, mode: "-layout" | "-raw"): Promise<ExtractResult> {
  return new Promise((resolve) => {
    const child = spawn("pdftotext", [mode, "-enc", "UTF-8", path, "-"], { timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PDF_TEXT) child.kill();
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8").slice(0, 300)));
    child.on("error", (error) => resolve({ ok: false, reason: `pdftotext unavailable: ${error.message}` }));
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true, text: Buffer.concat(out).toString("utf8") } : { ok: false, reason: err.trim() || `pdftotext exit ${code}` }),
    );
  });
}

function stripMarkup(path: string, text: string): string {
  const ext = extname(path).toLowerCase();
  if (ext !== ".html" && ext !== ".htm") return text;
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
