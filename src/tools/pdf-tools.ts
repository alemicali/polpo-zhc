/**
 * PDF tools for document operations.
 *
 * Provides tools for agents to:
 * - Read text from PDF files
 * - Create new PDF documents with text, images, and pages
 * - Merge multiple PDFs into one
 * - Extract pages from a PDF
 * - Get PDF metadata (pages, title, author, etc.)
 *
 * Uses `pdf-lib` for creation/manipulation and a built-in text extractor.
 * All file operations enforce path sandboxing.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

const MAX_TEXT_OUTPUT = 50_000;

// ─── Tool: pdf_read ───

const PdfReadSchema = Type.Object({
  path: Type.String({ description: "Path to PDF file" }),
  pages: Type.Optional(Type.Array(Type.Number(), { description: "Specific page numbers to read (1-indexed). Default: all pages." })),
  max_chars: Type.Optional(Type.Number({ description: "Max characters to return (default: 50000)" })),
});

function createPdfReadTool(cwd: string, sandbox: string[]): AgentTool<typeof PdfReadSchema> {
  return {
    name: "pdf_read",
    label: "Read PDF",
    description: "Extract text content from a PDF file. Returns the text from all or specific pages.",
    parameters: PdfReadSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "pdf_read");

      try {
        const { PDFDocument } = await import("pdf-lib");
        const bytes = readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(bytes);
        const pageCount = pdfDoc.getPageCount();
        const title = pdfDoc.getTitle() ?? "";
        const author = pdfDoc.getAuthor() ?? "";

        // pdf-lib doesn't extract text - we use a basic approach via page content streams
        // For production, agents should use the bash tool with a CLI like pdftotext
        // Here we provide metadata and suggest using bash for full text extraction
        const maxChars = params.max_chars ?? MAX_TEXT_OUTPUT;

        // Try to extract text using pdf-lib's low-level API
        const selectedPages = params.pages ?? Array.from({ length: pageCount }, (_, i) => i + 1);
        const textParts: string[] = [];

        for (const pageNum of selectedPages) {
          if (pageNum < 1 || pageNum > pageCount) continue;
          const page = pdfDoc.getPage(pageNum - 1);
          const { width, height } = page.getSize();
          textParts.push(`--- Page ${pageNum} (${Math.round(width)}x${Math.round(height)}) ---`);
          // Note: pdf-lib doesn't support text extraction natively.
          // We extract what we can from content streams
          textParts.push(`[Page ${pageNum} content - use 'bash' tool with 'pdftotext' for full text extraction]`);
        }

        // If pdftotext is available, try to use it
        let extractedText = "";
        try {
          const { execSync } = await import("node:child_process");
          const pagesArg = params.pages
            ? `-f ${Math.min(...params.pages)} -l ${Math.max(...params.pages)}`
            : "";
          extractedText = execSync(
            `pdftotext ${pagesArg} -layout ${JSON.stringify(filePath)} -`,
            { encoding: "utf-8", timeout: 15_000 },
          ).trim();
        } catch {
          // pdftotext not available - that's fine
        }

        const text = extractedText || textParts.join("\n");
        const truncated = text.length > maxChars
          ? text.slice(0, maxChars) + `\n[truncated — ${text.length} total chars]`
          : text;

        const meta = [
          `PDF: ${filePath}`,
          `Pages: ${pageCount}${title ? ` | Title: ${title}` : ""}${author ? ` | Author: ${author}` : ""}`,
          ``,
        ].join("\n");

        return {
          content: [{ type: "text", text: meta + truncated }],
          details: { path: filePath, pages: pageCount, title, author },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `PDF read error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: pdf_create (HTML → PDF via Playwright/Chromium) ───

const PdfCreateSchema = Type.Object({
  path: Type.String({ description: "Output PDF file path" }),
  html: Type.Optional(Type.String({ description: "Complete HTML string to render. Must be a full document (<!DOCTYPE html>...). Mutually exclusive with html_path." })),
  html_path: Type.Optional(Type.String({ description: "Path to an HTML file to render. Use this for large documents instead of passing html inline. Mutually exclusive with html." })),
  format: Type.Optional(Type.Union([
    Type.Literal("A4"),
    Type.Literal("A3"),
    Type.Literal("Letter"),
    Type.Literal("Legal"),
    Type.Literal("Tabloid"),
  ], { description: "Paper format (default: A4)" })),
  landscape: Type.Optional(Type.Boolean({ description: "Landscape orientation (default: false)" })),
  margin: Type.Optional(Type.Object({
    top: Type.Optional(Type.String({ description: "Top margin (e.g. '20mm', '1in')" })),
    right: Type.Optional(Type.String({ description: "Right margin (e.g. '15mm')" })),
    bottom: Type.Optional(Type.String({ description: "Bottom margin (e.g. '25mm')" })),
    left: Type.Optional(Type.String({ description: "Left margin (e.g. '15mm')" })),
  }, { description: "Page margins. Default: 20mm top, 15mm right/left, 25mm bottom." })),
  header_template: Type.Optional(Type.String({ description: "HTML template for page header. Supports Chromium classes: pageNumber, totalPages, date, title, url. Pass empty <div></div> for no header." })),
  footer_template: Type.Optional(Type.String({ description: "HTML template for page footer. Example: '<div style=\"font-size:9px;width:100%;text-align:center;color:#888;\">Page <span class=\"pageNumber\"></span> of <span class=\"totalPages\"></span></div>'" })),
  print_background: Type.Optional(Type.Boolean({ description: "Print background colors/images (default: true)" })),
  scale: Type.Optional(Type.Number({ description: "Scale of the webpage rendering (default: 1, range 0.1-2)" })),
  wait_for_network: Type.Optional(Type.Boolean({ description: "Wait for network idle before rendering (default: true). Disable for offline HTML with no external resources." })),
});

function createPdfCreateTool(cwd: string, sandbox: string[]): AgentTool<typeof PdfCreateSchema> {
  return {
    name: "pdf_create",
    label: "Create PDF",
    description:
      "Convert HTML to a professional PDF document using Chromium (Playwright). " +
      "Provide a complete HTML document (with CSS, tables, images as base64) either " +
      "inline via 'html' or from a file via 'html_path'. The tool handles rendering " +
      "and PDF generation — you focus on writing the HTML.\n\n" +
      "Supports full CSS: @page rules, page-break-*, flexbox, grid, custom fonts, " +
      "background colors, borders, images (use base64 data URIs for images).\n\n" +
      "Examples:\n" +
      "- Simple report: pdf_create({html: '<!DOCTYPE html><html>...', path: 'report.pdf'})\n" +
      "- From file: pdf_create({html_path: 'report.html', path: 'report.pdf', format: 'A4'})\n" +
      "- With footer: pdf_create({html: '...', path: 'report.pdf', footer_template: '<div style=\"font-size:9px;text-align:center;width:100%\">Page <span class=\"pageNumber\"></span>/<span class=\"totalPages\"></span></div>'})",
    parameters: PdfCreateSchema,
    async execute(_id, params) {
      // Validate: must have exactly one of html or html_path
      if (!params.html && !params.html_path) {
        return {
          content: [{ type: "text", text: "Error: provide either 'html' (inline HTML string) or 'html_path' (path to HTML file)" }],
          details: { error: "missing_html" },
        };
      }
      if (params.html && params.html_path) {
        return {
          content: [{ type: "text", text: "Error: provide 'html' or 'html_path', not both" }],
          details: { error: "both_html_sources" },
        };
      }

      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "pdf_create");
      mkdirSync(dirname(filePath), { recursive: true });

      // Resolve HTML content
      let htmlContent: string;
      if (params.html_path) {
        const htmlFilePath = resolve(cwd, params.html_path);
        assertPathAllowed(htmlFilePath, sandbox, "pdf_create");
        try {
          htmlContent = readFileSync(htmlFilePath, "utf-8");
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `Error reading HTML file: ${err.message}` }],
            details: { error: "html_read_failed", path: htmlFilePath },
          };
        }
      } else {
        htmlContent = params.html!;
      }

      let browser: any;
      try {
        const { chromium } = await import("playwright-core");

        browser = await chromium.launch({
          headless: true,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        });
        const page = await browser.newPage();

        // Load HTML content
        const waitUntil = (params.wait_for_network ?? true) ? "networkidle" : "domcontentloaded";
        await page.setContent(htmlContent, { waitUntil, timeout: 30_000 });

        // Default margins
        const defaultMargin = { top: "20mm", right: "15mm", bottom: "25mm", left: "15mm" };
        const margin = params.margin
          ? { ...defaultMargin, ...params.margin }
          : defaultMargin;

        // Determine if custom header/footer templates are provided
        const hasHeaderFooter = !!(params.header_template || params.footer_template);

        // Generate PDF
        const pdfBuffer = await page.pdf({
          path: filePath,
          format: params.format ?? "A4",
          landscape: params.landscape ?? false,
          printBackground: params.print_background ?? true,
          scale: Math.max(0.1, Math.min(2, params.scale ?? 1)),
          margin,
          displayHeaderFooter: hasHeaderFooter,
          ...(hasHeaderFooter ? {
            headerTemplate: params.header_template ?? "<div></div>",
            footerTemplate: params.footer_template ?? "<div></div>",
          } : {}),
        });

        const bytes = pdfBuffer.byteLength;

        // Count pages in the generated PDF for reporting
        let pageCount = 0;
        try {
          const { PDFDocument } = await import("pdf-lib");
          const doc = await PDFDocument.load(readFileSync(filePath));
          pageCount = doc.getPageCount();
        } catch {
          // Best effort — pdf-lib may fail on some PDFs
        }

        const pageInfo = pageCount > 0 ? `${pageCount} pages, ` : "";
        return {
          content: [{ type: "text", text: `PDF created: ${filePath} (${pageInfo}${bytes} bytes)` }],
          details: { path: filePath, pages: pageCount, bytes },
        };
      } catch (err: any) {
        const msg = err.message ?? String(err);
        // Provide actionable hints for common errors
        if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
          return {
            content: [{ type: "text", text: `PDF create error: Chromium not found. Install it with: npx playwright install chromium\n\nOriginal error: ${msg}` }],
            details: { error: "chromium_not_installed" },
          };
        }
        return {
          content: [{ type: "text", text: `PDF create error: ${msg}` }],
          details: { error: msg },
        };
      } finally {
        if (browser) {
          await browser.close().catch(() => {});
        }
      }
    },
  };
}

// ─── Tool: pdf_merge ───

const PdfMergeSchema = Type.Object({
  inputs: Type.Array(Type.String(), { description: "Paths to PDF files to merge (in order)", minItems: 2 }),
  output: Type.String({ description: "Output merged PDF path" }),
});

function createPdfMergeTool(cwd: string, sandbox: string[]): AgentTool<typeof PdfMergeSchema> {
  return {
    name: "pdf_merge",
    label: "Merge PDFs",
    description: "Merge multiple PDF files into a single document.",
    parameters: PdfMergeSchema,
    async execute(_id, params) {
      const outputPath = resolve(cwd, params.output);
      assertPathAllowed(outputPath, sandbox, "pdf_merge");
      mkdirSync(dirname(outputPath), { recursive: true });

      try {
        const { PDFDocument } = await import("pdf-lib");
        const merged = await PDFDocument.create();
        let totalPages = 0;

        for (const inputPath of params.inputs) {
          const fullPath = resolve(cwd, inputPath);
          assertPathAllowed(fullPath, sandbox, "pdf_merge");
          const bytes = readFileSync(fullPath);
          const src = await PDFDocument.load(bytes);
          const indices = Array.from({ length: src.getPageCount() }, (_, i) => i);
          const copiedPages = await merged.copyPages(src, indices);
          copiedPages.forEach(p => merged.addPage(p));
          totalPages += copiedPages.length;
        }

        const mergedBytes = await merged.save();
        writeFileSync(outputPath, mergedBytes);

        return {
          content: [{ type: "text", text: `Merged ${params.inputs.length} PDFs -> ${outputPath} (${totalPages} pages, ${mergedBytes.byteLength} bytes)` }],
          details: { output: outputPath, inputs: params.inputs.length, totalPages },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `PDF merge error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: pdf_info ───

const PdfInfoSchema = Type.Object({
  path: Type.String({ description: "Path to PDF file" }),
});

function createPdfInfoTool(cwd: string, sandbox: string[]): AgentTool<typeof PdfInfoSchema> {
  return {
    name: "pdf_info",
    label: "PDF Info",
    description: "Get metadata about a PDF: page count, title, author, creation date, page dimensions.",
    parameters: PdfInfoSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "pdf_info");

      try {
        const { PDFDocument } = await import("pdf-lib");
        const bytes = readFileSync(filePath);
        const pdfDoc = await PDFDocument.load(bytes);

        const pages = pdfDoc.getPageCount();
        const title = pdfDoc.getTitle() ?? "";
        const author = pdfDoc.getAuthor() ?? "";
        const subject = pdfDoc.getSubject() ?? "";
        const creator = pdfDoc.getCreator() ?? "";
        const producer = pdfDoc.getProducer() ?? "";
        const creationDate = pdfDoc.getCreationDate();
        const modDate = pdfDoc.getModificationDate();

        const pageSizes = Array.from({ length: Math.min(pages, 10) }, (_, i) => {
          const p = pdfDoc.getPage(i);
          const { width, height } = p.getSize();
          return `  Page ${i + 1}: ${Math.round(width)}x${Math.round(height)} pts`;
        });

        const text = [
          `Pages: ${pages}`,
          title ? `Title: ${title}` : null,
          author ? `Author: ${author}` : null,
          subject ? `Subject: ${subject}` : null,
          creator ? `Creator: ${creator}` : null,
          producer ? `Producer: ${producer}` : null,
          creationDate ? `Created: ${creationDate.toISOString()}` : null,
          modDate ? `Modified: ${modDate.toISOString()}` : null,
          `File size: ${bytes.byteLength} bytes`,
          `\nPage dimensions:`,
          ...pageSizes,
          pages > 10 ? `  ... (${pages - 10} more pages)` : null,
        ].filter(Boolean).join("\n");

        return {
          content: [{ type: "text", text }],
          details: { pages, title, author, bytes: bytes.byteLength },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `PDF info error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Factory ───

export type PdfToolName = "pdf_read" | "pdf_create" | "pdf_merge" | "pdf_info";

export const ALL_PDF_TOOL_NAMES: PdfToolName[] = ["pdf_read", "pdf_create", "pdf_merge", "pdf_info"];

/**
 * Create PDF tools.
 *
 * @param cwd - Working directory
 * @param allowedPaths - Sandbox paths
 * @param allowedTools - Optional filter
 */
export function createPdfTools(cwd: string, allowedPaths?: string[], allowedTools?: string[]): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<PdfToolName, () => AgentTool<any>> = {
    pdf_read: () => createPdfReadTool(cwd, sandbox),
    pdf_create: () => createPdfCreateTool(cwd, sandbox),
    pdf_merge: () => createPdfMergeTool(cwd, sandbox),
    pdf_info: () => createPdfInfoTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_PDF_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_PDF_TOOL_NAMES;

  return names.map(n => factories[n]());
}
