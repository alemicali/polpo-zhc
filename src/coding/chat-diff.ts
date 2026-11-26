/**
 * Diffs for the edit tools of a coding chat, from their input (Claude Code's Edit / MultiEdit /
 * Write / NotebookEdit; Codex's apply_patch with the diffs it reports): unified, line based, enough
 * for the chat's tool cards.
 */
const MAX_DIFF_CHARS = 40_000;
const MAX_LINES = 400;

function lines(s: string): string[] {
  const l = s.replace(/\r\n/g, "\n").split("\n");
  if (l.length > 1 && l[l.length - 1] === "") l.pop();
  return l;
}

/** One hunk: the common head and tail as context (up to 3 lines), the middle as removed and added lines. */
export function lineDiff(path: string, before: string, after: string): string {
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ctxBefore = a.slice(Math.max(0, head - 3), head);
  const removed = a.slice(head, a.length - tail);
  const added = b.slice(head, b.length - tail);
  const ctxAfter = a.slice(a.length - tail, Math.min(a.length, a.length - tail + 3));
  const start = head - ctxBefore.length + 1;
  const out = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},${ctxBefore.length + removed.length + ctxAfter.length} +${start},${ctxBefore.length + added.length + ctxAfter.length} @@`,
    ...ctxBefore.map((l) => ` ${l}`),
    ...removed.slice(0, MAX_LINES).map((l) => `-${l}`),
    ...(removed.length > MAX_LINES ? [`-… ${removed.length - MAX_LINES} more lines`] : []),
    ...added.slice(0, MAX_LINES).map((l) => `+${l}`),
    ...(added.length > MAX_LINES ? [`+… ${added.length - MAX_LINES} more lines`] : []),
    ...ctxAfter.map((l) => ` ${l}`),
  ];
  return out.join("\n");
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The diff an edit tool call makes, or undefined (not an edit). */
export function editDiff(tool: string, input: unknown): string | undefined {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const path = str(i.file_path) || str(i.path) || str(i.notebook_path) || "file";
  let diff: string | undefined;
  switch (tool.toLowerCase()) {
    case "edit":
      diff = lineDiff(path, str(i.old_string), str(i.new_string));
      break;
    case "multiedit": {
      const edits = Array.isArray(i.edits) ? (i.edits as Array<Record<string, unknown>>) : [];
      diff = edits.map((e) => lineDiff(path, str(e?.old_string), str(e?.new_string))).join("\n");
      break;
    }
    case "write":
      diff = lineDiff(path, "", str(i.content));
      break;
    case "notebookedit":
      diff = lineDiff(path, "", str(i.new_source));
      break;
    case "apply_patch": {
      const changes = Array.isArray(i.changes) ? (i.changes as Array<Record<string, unknown>>) : [];
      const parts = changes.map((c) => {
        const d = str(c?.diff);
        if (!d) return "";
        return /^(?:---|diff )/m.test(d) ? d : `--- a/${str(c.path)}\n+++ b/${str(c.path)}\n${d}`;
      }).filter(Boolean);
      diff = parts.length ? parts.join("\n") : undefined;
      break;
    }
    default:
      return undefined;
  }
  if (!diff) return undefined;
  return diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff cut)` : diff;
}

/** Tools that change the worktree (edits, and commands, which may). */
export function changesFiles(tool: string): boolean {
  return /^(?:edit|multiedit|write|notebookedit|apply_patch|bash|shell|local_shell|exec_command)$/i.test(tool);
}
