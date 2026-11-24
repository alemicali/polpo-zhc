/**
 * The single muted line a tool call collapses to in chat ("Read file · src/app.ts",
 * "Searched the web for “polpo”", "Ran bash · npm test"), like claude.ai. Pure helpers,
 * kept out of tool.tsx so that file only exports components.
 */

export type ToolState = "preparing" | "calling" | "completed" | "error" | "interrupted";

export interface ToolCallInfo {
  id: string;
  name: string;
  argumentsText?: string;
  arguments?: Record<string, unknown>;
  result?: string;
  progress?: {
    message: string;
    taskId?: string;
    status?: string;
    elapsedMs?: number;
  };
  state: ToolState;
}

/** Convert tool_name to "Tool name" (sentence case, like the rest of the line). */
export function formatToolName(name: string): string {
  const spaced = name.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : name;
}

/** [while running, once done] verbs for the tools people see most. Others: "Tool name". */
const TOOL_VERBS: Record<string, [string, string]> = {
  read: ["Reading file", "Read file"],
  read_file: ["Reading file", "Read file"],
  write: ["Writing file", "Wrote file"],
  write_file: ["Writing file", "Wrote file"],
  edit: ["Editing file", "Edited file"],
  edit_file: ["Editing file", "Edited file"],
  bash: ["Running bash", "Ran bash"],
  glob: ["Finding files", "Found files"],
  grep: ["Searching files", "Searched files"],
  grep_files: ["Searching files", "Searched files"],
  ls: ["Listing", "Listed"],
  search_web: ["Searching the web for", "Searched the web for"],
  web_search: ["Searching the web for", "Searched the web for"],
  search_find_similar: ["Finding similar pages to", "Found similar pages to"],
  http_fetch: ["Fetching", "Fetched"],
  web_fetch: ["Fetching", "Fetched"],
  http_download: ["Downloading", "Downloaded"],
  browser_navigate: ["Opening", "Opened"],
  browser_screenshot: ["Taking a screenshot", "Took a screenshot"],
  browser_snapshot: ["Reading the page", "Read the page"],
  browser_click: ["Clicking", "Clicked"],
  browser_type: ["Typing", "Typed"],
  memory_save: ["Saving memory", "Saved memory"],
  memory_get: ["Reading memory", "Read memory"],
  create_task: ["Creating task", "Created task"],
  wait_for_task: ["Waiting for task", "Waited for task"],
  ask_agent: ["Asking", "Asked"],
  message_agent: ["Messaging", "Messaged"],
  image_generate: ["Generating image", "Generated image"],
  artifact_create: ["Creating artifact", "Created artifact"],
  artifact_update: ["Updating artifact", "Updated artifact"],
  artifact_from_file: ["Publishing artifact from a file", "Published artifact from a file"],
  render_widget: ["Rendering widget", "Rendered widget"],
};

/** Tools whose target reads like a phrase ("Searched the web for “x”"), not "Verb · x". */
const QUOTED_TARGET = new Set(["search_web", "web_search", "search_find_similar"]);

/** Argument keys that name what a call is about, in order of preference. */
const TARGET_KEYS = [
  "path", "file_path", "filePath", "file", "command", "query", "pattern", "url",
  "title", "name", "agent", "agentName", "taskId", "task_id", "id",
];

const PATTERN_FIRST = new Set(["grep", "grep_files", "glob"]);

function oneLine(value: string, max = 80): string {
  const first = value.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const trimmed = first.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** What the call is about: the path, command, query, URL… from its arguments. */
function toolTarget(tool: ToolCallInfo): string | undefined {
  const args = tool.arguments;
  if (!args) return undefined;
  // searches are about their pattern, not the folder they look in
  const keys = PATTERN_FIRST.has(tool.name) ? ["pattern", ...TARGET_KEYS] : TARGET_KEYS;
  for (const key of keys) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) return oneLine(v);
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Short reason for a failed call: the first line of its error output. */
export function toolErrorReason(tool: ToolCallInfo): string | undefined {
  if (!tool.result) return undefined;
  const line = oneLine(tool.result.replace(/^\s*(?:error|failed)\s*:\s*/i, ""), 72);
  return line || undefined;
}

export interface ToolSummary {
  /** "Read file", "Ran bash", "Searched the web for", "Get status"… */
  label: string;
  /** "src/app.ts", "npm test", "“polpo”"… */
  target?: string;
  /** Whole line as plain text: "Read file · src/app.ts". */
  text: string;
}

/** The single muted line a tool call collapses to, like claude.ai. */
export function describeTool(tool: ToolCallInfo): ToolSummary {
  const running = tool.state === "preparing" || tool.state === "calling";
  const verbs = TOOL_VERBS[tool.name];
  const label = verbs ? verbs[running ? 0 : 1] : formatToolName(tool.name);
  const raw = toolTarget(tool);
  const target = raw && QUOTED_TARGET.has(tool.name) ? `“${raw}”` : raw;
  const text = target
    ? QUOTED_TARGET.has(tool.name) ? `${label} ${target}` : `${label} · ${target}`
    : label;
  return { label, target, text };
}

export function isRunning(state: ToolState) {
  return state === "preparing" || state === "calling";
}

