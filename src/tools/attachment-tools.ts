/**
 * Attachment tool — reads any attached file by dispatching to the appropriate reader.
 *
 * Detects file type from extension and delegates:
 *   .pdf       → pdf-lib text extraction
 *   .docx      → mammoth text extraction
 *   .xlsx/.csv → exceljs content extraction
 *   .png/.jpg/.gif/.webp/.svg → ImageContent (multimodal)
 *   everything else → plain text read
 *
 * All heavy deps use dynamic import (same pattern as pdf-tools, docx-tools, etc.).
 */

import { resolve, extname } from "node:path";
import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { assertPathAllowed } from "./path-sandbox.js";

const MAX_TEXT_OUTPUT = 50_000;

const ReadAttachmentSchema = Type.Object({
  path: Type.String({ description: "Path to the attachment file (as provided in the chat message)" }),
});

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const PDF_EXTS = new Set([".pdf"]);
const DOCX_EXTS = new Set([".docx"]);
const EXCEL_EXTS = new Set([".xlsx", ".xls"]);
const CSV_EXTS = new Set([".csv", ".tsv"]);

const MIME_MAP: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp",
};

async function readPdf(filePath: string, maxChars: number): Promise<string> {
  const { PDFDocument } = await import("pdf-lib");
  const bytes = readFileSync(filePath);
  const doc = await PDFDocument.load(bytes);
  const pageCount = doc.getPageCount();
  const title = doc.getTitle() ?? "";
  const author = doc.getAuthor() ?? "";

  let info = `PDF: ${pageCount} pages`;
  if (title) info += `, title: "${title}"`;
  if (author) info += `, author: ${author}`;
  info += `\n\nNote: For full text extraction, use: bash { command: "pdftotext '${filePath}' -" }`;
  return info;
}

async function readDocx(filePath: string, maxChars: number): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.default.extractRawText({ path: filePath });
  const text = result.value;
  return text.length > maxChars ? text.slice(0, maxChars) + "\n...(truncated)" : text;
}

async function readExcel(filePath: string, maxChars: number): Promise<string> {
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.default.Workbook();
  await workbook.xlsx.readFile(filePath);

  const parts: string[] = [];
  for (const sheet of workbook.worksheets) {
    parts.push(`## Sheet: ${sheet.name} (${sheet.rowCount} rows × ${sheet.columnCount} cols)`);
    const rows: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rows.length >= 50) return; // cap preview
      const cells = row.values as unknown[];
      rows.push(cells.slice(1).map(v => String(v ?? "")).join("\t"));
    });
    parts.push(rows.join("\n"));
  }
  const text = parts.join("\n\n");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n...(truncated)" : text;
}

async function readCsv(filePath: string, maxChars: number): Promise<string> {
  const content = readFileSync(filePath, "utf-8");
  return content.length > maxChars ? content.slice(0, maxChars) + "\n...(truncated)" : content;
}

async function readText(filePath: string, maxChars: number): Promise<string> {
  const content = readFileSync(filePath, "utf-8");
  return content.length > maxChars ? content.slice(0, maxChars) + "\n...(truncated)" : content;
}

function createReadAttachmentTool(cwd: string, sandbox: string[]): AgentTool<typeof ReadAttachmentSchema> {
  return {
    name: "read_attachment",
    label: "Read Attachment",
    description:
      "Read a file attached by the user. Automatically detects the file type and extracts content. " +
      "Works with PDF, DOCX, XLSX, CSV, images, and any text file. " +
      "For images, returns the image data for visual analysis (if your model supports it).",
    parameters: ReadAttachmentSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "read_attachment");

      const ext = extname(filePath).toLowerCase();

      try {
        // Images → return as ImageContent for multimodal models
        if (IMAGE_EXTS.has(ext)) {
          const data = readFileSync(filePath);
          const base64 = data.toString("base64");
          const mimeType = MIME_MAP[ext] ?? "image/png";
          return {
            content: [
              { type: "image" as const, data: base64, mimeType },
              { type: "text" as const, text: `Image: ${params.path} (${data.byteLength} bytes, ${mimeType})` },
            ],
            details: undefined,
          };
        }

        // PDF
        if (PDF_EXTS.has(ext)) {
          const text = await readPdf(filePath, MAX_TEXT_OUTPUT);
          return { content: [{ type: "text", text }], details: undefined };
        }

        // DOCX
        if (DOCX_EXTS.has(ext)) {
          const text = await readDocx(filePath, MAX_TEXT_OUTPUT);
          return { content: [{ type: "text", text }], details: undefined };
        }

        // Excel
        if (EXCEL_EXTS.has(ext)) {
          const text = await readExcel(filePath, MAX_TEXT_OUTPUT);
          return { content: [{ type: "text", text }], details: undefined };
        }

        // CSV/TSV
        if (CSV_EXTS.has(ext)) {
          const text = await readCsv(filePath, MAX_TEXT_OUTPUT);
          return { content: [{ type: "text", text }], details: undefined };
        }

        // Everything else → plain text
        const text = await readText(filePath, MAX_TEXT_OUTPUT);
        return { content: [{ type: "text", text }], details: undefined };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error reading attachment: ${msg}` }], details: undefined };
      }
    },
  };
}

export function createAttachmentTools(cwd: string, allowedPaths?: string[], allowedTools?: string[]): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [];
  const sandbox = allowedPaths ?? [cwd];

  if (!allowedTools || allowedTools.includes("read_attachment")) {
    tools.push(createReadAttachmentTool(cwd, sandbox));
  }

  return tools;
}

export const ALL_ATTACHMENT_TOOL_NAMES = ["read_attachment"];
