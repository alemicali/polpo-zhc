/**
 * The artifact type (and kind) of an uploaded file, from its name, media type and first bytes.
 *
 * Office files (.docx, .xlsx, .pptx) are not converted on the server: the dashboard's Upload converts
 * them with its importers into a document, a sheets or a slides workspace and uploads that. A server
 * upload of one is refused with that hint.
 */
import type { ArtifactType } from "@polpo-ai/core/artifacts";

export type DetectedArtifact = { type: ArtifactType; kind?: string };

const OFFICE = /\.(docx?|xlsx?|pptx?|odt|ods|odp|pdf|key|numbers|pages)$/i;
const MERMAID = /^\s*(%%.*\n\s*)*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|sankey-beta|xychart-beta|block-beta|C4Context)\b/;

/** The workspace kind of a JSON model (from its first KB), or undefined. */
function workspaceKind(head: string): string | undefined {
  const start = head.trimStart();
  if (!start.startsWith("{")) return undefined;
  const keys = [...start.slice(0, 64 * 1024).matchAll(/"(slides|sheets|scenes)"\s*:\s*\[/g)].map((m) => m[1]);
  if (keys.includes("slides")) return "slides";
  if (keys.includes("sheets")) return "sheets";
  if (keys.includes("scenes")) return "motion";
  return undefined;
}

export class UnsupportedArtifactFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedArtifactFileError";
  }
}

/**
 * The type and kind of a file. `head` is its first few KB as text. Throws
 * UnsupportedArtifactFileError for files that are not artifacts (office files, unknown JSON).
 */
export function detectArtifactType(input: { filename?: string; mime?: string; head: string }): DetectedArtifact {
  const name = (input.filename ?? "").toLowerCase();
  const mime = (input.mime ?? "").split(";")[0]!.trim().toLowerCase();
  const head = input.head;
  if (OFFICE.test(name) || /officedocument|msword|ms-excel|ms-powerpoint|application\/pdf/.test(mime)) {
    throw new UnsupportedArtifactFileError("Office files and PDFs are not converted on the server: upload them in the dashboard (Artifacts → Upload converts .docx, .xlsx and .pptx into a document, sheets or slides), or save them as files");
  }
  const json = () => {
    const kind = workspaceKind(head);
    if (!kind) throw new UnsupportedArtifactFileError("This JSON is not an artifact workspace: a slides ({version:1, slides:[…]}), sheets ({version:1, sheets:[…]}) or motion ({version:1, scenes:[…]}) model");
    return { type: "html" as const, kind };
  };
  const html = (): DetectedArtifact => ({ type: "html", kind: /data-polpo-design-workspace/.test(head) ? "design" : "page" });
  if (/\.(md|markdown|mdx|txt|text)$/.test(name)) return { type: "doc" };
  if (/\.(html?|xhtml)$/.test(name)) return html();
  if (/\.svg$/.test(name)) return { type: "svg" };
  if (/\.(mmd|mermaid)$/.test(name)) return { type: "mermaid" };
  if (/\.json$/.test(name)) return json();
  if (mime === "text/markdown" || mime === "text/plain") return { type: "doc" };
  if (mime === "text/html") return html();
  if (mime === "image/svg+xml") return { type: "svg" };
  if (mime === "application/json") return json();
  const start = head.trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(start)) return { type: "svg" };
  if (/^(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(start)) return html();
  if (start.startsWith("{")) return json();
  if (MERMAID.test(head)) return { type: "mermaid" };
  return { type: "doc" };
}
