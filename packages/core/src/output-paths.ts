/**
 * Where a task saves the files it delivers, named so a person can tell which task produced what:
 *
 *   output/<mission run>/<NN> - <task title>/     tasks of a mission (the run name is unique: "report (2)")
 *   output/tasks/<task title> - <id>/              tasks outside a mission
 *
 * Paths are relative to the agents' working directory and use "/" (pure: no node:path), so the
 * runner, the agents' prompt and the dashboard all derive the same folder from the task alone.
 */

export const OUTPUT_ROOT = "output";
export const STANDALONE_TASKS_FOLDER = "tasks";

const MAX_SEGMENT = 60;
// Characters Windows refuses in a file name, plus control characters.
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A name usable as one folder on every platform: no separators, no trailing dot/space, not hidden. */
export function safeFolderName(name: string, fallback = "untitled"): string {
  let s = name.replace(/\s+/g, " ").replace(INVALID_CHARS, "-").trim().replace(/^\.+/, "");
  if (s.length > MAX_SEGMENT) s = s.slice(0, MAX_SEGMENT);
  s = s.replace(/[. ]+$/, "");
  if (!s) s = fallback;
  if (RESERVED_NAMES.test(s)) s = `${s}_`;
  return s;
}

/**
 * Output folder of a task, relative to the agents' working directory.
 * `position` is the task's 1-based place in its mission (it orders the folders as the tasks run);
 * without it the folder is just the title (titles are unique within a mission run).
 */
export function taskOutputPath(task: { id: string; title: string; group?: string }, position?: number): string {
  if (!task.group) {
    return `${OUTPUT_ROOT}/${STANDALONE_TASKS_FOLDER}/${safeFolderName(task.title)} - ${task.id.slice(0, 6)}`;
  }
  const prefix = position && position > 0 ? `${String(position).padStart(2, "0")} - ` : "";
  return `${OUTPUT_ROOT}/${safeFolderName(task.group, "mission")}/${prefix}${safeFolderName(task.title)}`;
}

/** Output folder of a mission run (the parent of its tasks' folders), relative to the agents' working directory. */
export function missionOutputPath(group: string): string {
  return `${OUTPUT_ROOT}/${safeFolderName(group, "mission")}`;
}

/**
 * File names a task description mentions without a folder ("save it in report.md"), limited to
 * kinds of files a task delivers (documents, data, media, archives; not source code), in order, once each.
 * Names inside a path ("docs/report.md") are left out: they already say where the file goes.
 */
export function bareFileNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(BARE_FILE_NAME)) names.add(match[1]);
  return [...names];
}

const DELIVERABLE_EXTENSIONS = [
  "md", "markdown", "txt", "rtf", "json", "jsonl", "csv", "tsv", "xml", "yaml", "yml", "html", "htm",
  "pdf", "docx", "doc", "xlsx", "xls", "pptx", "odt", "ods", "odp",
  "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "mp3", "wav", "ogg", "m4a", "mp4", "webm", "mov", "zip", "log",
];
// A name not preceded or followed by a path separator or another name character.
const BARE_FILE_NAME = new RegExp(
  `(?<![\\p{L}\\p{N}_/\\\\.-])([\\p{L}\\p{N}_][\\p{L}\\p{N}_-]*(?:\\.[\\p{L}\\p{N}_-]+)*\\.(?:${DELIVERABLE_EXTENSIONS.join("|")}))(?![\\p{L}\\p{N}_/\\\\-])`,
  "giu",
);

/** 1-based position of a task in its mission document (by title), or undefined. */
export function taskPosition(missionData: string | undefined, title: string): number | undefined {
  if (!missionData) return undefined;
  try {
    const doc = JSON.parse(missionData) as { tasks?: Array<{ title?: string }> };
    const index = doc.tasks?.findIndex((t) => t.title === title) ?? -1;
    return index >= 0 ? index + 1 : undefined;
  } catch {
    return undefined;
  }
}
