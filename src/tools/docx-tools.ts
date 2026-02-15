/**
 * Word/DOCX tools for document operations.
 *
 * Provides tools for agents to:
 * - Read .docx files (extract text, HTML, or Markdown)
 * - Create .docx files with rich content (headings, paragraphs, tables, lists)
 *
 * Uses `mammoth` for reading and `docx` for creation.
 * All file operations enforce path sandboxing.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";

const MAX_TEXT_OUTPUT = 50_000;

/** Convert basic HTML to Markdown (headings, paragraphs, lists, bold, italic) */
function htmlToBasicMarkdown(html: string): string {
  return html
    // Headings
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n")
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n")
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n")
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n")
    .replace(/<h5[^>]*>(.*?)<\/h5>/gi, "##### $1\n\n")
    .replace(/<h6[^>]*>(.*?)<\/h6>/gi, "###### $1\n\n")
    // Bold/italic
    .replace(/<strong>(.*?)<\/strong>/gi, "**$1**")
    .replace(/<em>(.*?)<\/em>/gi, "*$1*")
    .replace(/<b>(.*?)<\/b>/gi, "**$1**")
    .replace(/<i>(.*?)<\/i>/gi, "*$1*")
    // Lists
    .replace(/<li>(.*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?[ou]l[^>]*>/gi, "\n")
    // Paragraphs and breaks
    .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Links
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Clean up whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Tool: docx_read ───

const DocxReadSchema = Type.Object({
  path: Type.String({ description: "Path to .docx file" }),
  format: Type.Optional(Type.Union([
    Type.Literal("text"),
    Type.Literal("markdown"),
    Type.Literal("html"),
  ], { description: "Output format: 'text' (plain), 'markdown', or 'html'. Default: 'text'" })),
});

function createDocxReadTool(cwd: string, sandbox: string[]): AgentTool<typeof DocxReadSchema> {
  return {
    name: "docx_read",
    label: "Read DOCX",
    description: "Read a Word document (.docx) and extract its content as plain text, Markdown, or HTML. " +
      "Preserves document structure (headings, lists, tables).",
    parameters: DocxReadSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "docx_read");

      try {
        const mammoth = await import("mammoth");
        const format = params.format ?? "text";

        let result;
        if (format === "html") {
          result = await mammoth.convertToHtml({ path: filePath });
        } else if (format === "markdown") {
          // mammoth doesn't export convertToMarkdown in all versions — use HTML + basic conversion
          const htmlResult = await mammoth.convertToHtml({ path: filePath });
          const md = htmlToBasicMarkdown(htmlResult.value);
          result = { value: md, messages: htmlResult.messages };
        } else {
          result = await mammoth.extractRawText({ path: filePath });
        }

        const text = result.value;
        const warnings = result.messages
          .filter((m: any) => m.type === "warning")
          .map((m: any) => m.message);

        const truncated = text.length > MAX_TEXT_OUTPUT
          ? text.slice(0, MAX_TEXT_OUTPUT) + `\n[truncated — ${text.length} total chars]`
          : text;

        const warningText = warnings.length > 0
          ? `\nWarnings: ${warnings.join("; ")}`
          : "";

        return {
          content: [{ type: "text", text: `DOCX (${format}): ${text.length} chars${warningText}\n\n${truncated}` }],
          details: { path: filePath, format, chars: text.length, warnings },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `DOCX read error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Tool: docx_create ───

const DocxCreateSchema = Type.Object({
  path: Type.String({ description: "Output .docx file path" }),
  title: Type.Optional(Type.String({ description: "Document title (appears as the first heading)" })),
  content: Type.Array(
    Type.Object({
      type: Type.Union([
        Type.Literal("heading"),
        Type.Literal("paragraph"),
        Type.Literal("bullet"),
        Type.Literal("numbered"),
      ], { description: "Block type" }),
      text: Type.String({ description: "Text content" }),
      level: Type.Optional(Type.Number({ description: "Heading level 1-6 (for type 'heading')" })),
      bold: Type.Optional(Type.Boolean({ description: "Bold text" })),
      italic: Type.Optional(Type.Boolean({ description: "Italic text" })),
    }),
    { description: "Document content blocks", minItems: 1 },
  ),
});

function createDocxCreateTool(cwd: string, sandbox: string[]): AgentTool<typeof DocxCreateSchema> {
  return {
    name: "docx_create",
    label: "Create DOCX",
    description: "Create a Word document (.docx) with headings, paragraphs, bullet lists, and numbered lists. " +
      "Supports bold and italic text formatting.",
    parameters: DocxCreateSchema,
    async execute(_id, params) {
      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "docx_create");
      mkdirSync(dirname(filePath), { recursive: true });

      try {
        const docxModule = await import("docx");
        const {
          Document, Paragraph, TextRun, HeadingLevel, Packer,
          AlignmentType, NumberFormat,
        } = docxModule;

        const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
          1: HeadingLevel.HEADING_1,
          2: HeadingLevel.HEADING_2,
          3: HeadingLevel.HEADING_3,
          4: HeadingLevel.HEADING_4,
          5: HeadingLevel.HEADING_5,
          6: HeadingLevel.HEADING_6,
        };

        const children: InstanceType<typeof Paragraph>[] = [];

        // Title
        if (params.title) {
          children.push(new Paragraph({
            text: params.title,
            heading: HeadingLevel.TITLE,
          }));
        }

        // Content blocks
        for (const block of params.content) {
          const textRun = new TextRun({
            text: block.text,
            bold: block.bold,
            italics: block.italic,
          });

          switch (block.type) {
            case "heading":
              children.push(new Paragraph({
                children: [textRun],
                heading: headingMap[block.level ?? 1] ?? HeadingLevel.HEADING_1,
              }));
              break;
            case "paragraph":
              children.push(new Paragraph({
                children: [textRun],
              }));
              break;
            case "bullet":
              children.push(new Paragraph({
                children: [textRun],
                bullet: { level: 0 },
              }));
              break;
            case "numbered":
              children.push(new Paragraph({
                children: [textRun],
                numbering: { reference: "default-numbering", level: 0 },
              }));
              break;
          }
        }

        // Check if we need numbered lists
        const hasNumbered = params.content.some(b => b.type === "numbered");
        const numbering = hasNumbered ? {
          config: [{
            reference: "default-numbering",
            levels: [{
              level: 0,
              format: NumberFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
            }],
          }],
        } : undefined;

        const doc = new Document({
          numbering,
          sections: [{ children }],
        });

        const buffer = await Packer.toBuffer(doc);
        writeFileSync(filePath, buffer);

        return {
          content: [{ type: "text", text: `DOCX created: ${filePath} (${params.content.length} blocks, ${buffer.byteLength} bytes)` }],
          details: { path: filePath, blocks: params.content.length, bytes: buffer.byteLength },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `DOCX create error: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  };
}

// ─── Factory ───

export type DocxToolName = "docx_read" | "docx_create";

export const ALL_DOCX_TOOL_NAMES: DocxToolName[] = ["docx_read", "docx_create"];

/**
 * Create Word/DOCX tools.
 *
 * @param cwd - Working directory
 * @param allowedPaths - Sandbox paths
 * @param allowedTools - Optional filter
 */
export function createDocxTools(cwd: string, allowedPaths?: string[], allowedTools?: string[]): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<DocxToolName, () => AgentTool<any>> = {
    docx_read: () => createDocxReadTool(cwd, sandbox),
    docx_create: () => createDocxCreateTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_DOCX_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_DOCX_TOOL_NAMES;

  return names.map(n => factories[n]());
}
