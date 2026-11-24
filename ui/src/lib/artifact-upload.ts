/**
 * Files people upload as artifacts. Text files (.md, .html, .svg, .mmd, workspace .json…) go to the
 * server as they are (it detects the type); spreadsheets (.xlsx, .csv) are converted here with the
 * Sheets importer into a sheets workspace. Word and PowerPoint files have no importer yet: they are
 * refused with a hint (export them as Markdown / JSON, or keep them on the Files page).
 */
import type { ArtifactType } from "./artifacts-api";

export interface PreparedArtifactFile {
  file: Blob;
  filename: string;
  title: string;
  type?: Exclude<ArtifactType, "view">;
  kind?: string;
}

/** Extensions the Upload button offers. */
export const ARTIFACT_UPLOAD_ACCEPT = ".md,.markdown,.txt,.html,.htm,.svg,.mmd,.mermaid,.json,.csv,.xlsx";

const titleOf = (name: string) => name.replace(/\.[^.]+$/, "") || "Uploaded artifact";

export async function prepareArtifactFile(file: File): Promise<PreparedArtifactFile> {
  const name = file.name || "artifact";
  if (/\.(xlsx|csv)$/i.test(name)) {
    const { readWorksheetFile } = await import("@/components/artifacts/artifact-sheets-import");
    const sheets = await readWorksheetFile(file);
    if (!sheets.length) throw new Error(`${name} has no visible sheet.`);
    const content = JSON.stringify({ version: 1, sheets });
    return { file: new Blob([content], { type: "application/json" }), filename: `${titleOf(name)}.json`, title: titleOf(name), type: "html", kind: "sheets" };
  }
  if (/\.(docx?|pptx?|odt|odp|pdf|key|pages)$/i.test(name)) {
    throw new Error(`${name}: Word, PowerPoint and PDF files are not converted yet. Export it as Markdown (.md) or HTML, or keep it on the Files page.`);
  }
  return { file, filename: name, title: titleOf(name) };
}

/** "12.4 MB" (the size format of the artifact lists). */
export { formatArtifactSize as formatSize } from "./artifacts-list";
