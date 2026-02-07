import type { TaskStatus } from "../core/types.js";
import { PROVIDERS } from "./constants.js";

/** Format milliseconds as human-readable elapsed time */
export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

/** Status icon for blessed tags */
export function getStatusIcon(status: TaskStatus): string {
  switch (status) {
    case "pending": return "{grey-fg}○{/grey-fg}";
    case "assigned": return "{cyan-fg}◉{/cyan-fg}";
    case "in_progress": return "{yellow-fg}●{/yellow-fg}";
    case "review": return "{magenta-fg}●{/magenta-fg}";
    case "done": return "{green-fg}●{/green-fg}";
    case "failed": return "{red-fg}✗{/red-fg}";
  }
}

/** Status label for blessed tags */
export function getStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "pending": return "{grey-fg}PENDING{/grey-fg}  ";
    case "assigned": return "{cyan-fg}ASSIGNED{/cyan-fg} ";
    case "in_progress": return "{yellow-fg}{bold}RUNNING{/bold}{/yellow-fg}  ";
    case "review": return "{magenta-fg}{bold}REVIEW{/bold}{/magenta-fg}   ";
    case "done": return "{green-fg}DONE{/green-fg}     ";
    case "failed": return "{red-fg}{bold}FAILED{/bold}{/red-fg}   ";
  }
}

/** Get human label for adapter value */
export function getProviderLabel(value: string): string {
  return PROVIDERS.find(p => p.value === value)?.label ?? value;
}

/** Strip ANSI escape codes */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x1B\x9B][[\]()#;?]*(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\x07|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g, "");
}

/** YAML with basic syntax coloring (blessed tags) */
export function formatYamlColored(yaml: string): string {
  return yaml.split("\n").map(line => {
    if (line.match(/^\s*#/)) return `{grey-fg}${line}{/grey-fg}`;
    if (line.match(/^\s*-\s/)) {
      return line.replace(/^(\s*-\s)(.*)$/, "{cyan-fg}$1{/cyan-fg}$2");
    }
    const kv = line.match(/^(\s*)(\w[\w\s]*?)(:)(.*)/);
    if (kv) {
      return `${kv[1]}{green-fg}${kv[2]}{/green-fg}{white-fg}${kv[3]}{/white-fg}${kv[4]}`;
    }
    return line;
  }).join("\n");
}

/** Human-readable plan formatting (blessed tags) */
export function formatPlanReadable(doc: any): string {
  const tasks = doc.tasks || [];
  const volatileTeam = doc.team as any[] | undefined;
  const lines: string[] = [];
  const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

  // Show volatile team if present
  if (volatileTeam && volatileTeam.length > 0) {
    lines.push(`  {bold}{yellow-fg}Volatile team{/yellow-fg}{/bold}  {grey-fg}(agents created for this plan only){/grey-fg}`);
    lines.push("");
    for (const a of volatileTeam) {
      const model = a.model ? `{grey-fg}${a.model}{/grey-fg}` : "";
      lines.push(`    {cyan-fg}${a.name}{/cyan-fg}  ${a.adapter || "claude-sdk"}  ${model}`);
      if (a.role) lines.push(`      {grey-fg}${a.role}{/grey-fg}`);
      if (a.skills?.length) lines.push(`      {yellow-fg}⚡{/yellow-fg} ${a.skills.join(", ")}`);
    }
    lines.push("");
    lines.push("  ───────────────────────────────");
    lines.push("");
  }

  lines.push(`  {bold}${tasks.length} task${tasks.length !== 1 ? "s" : ""}{/bold} in plan`);
  lines.push("");

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const num = circled[i] ?? `(${i + 1})`;

    lines.push(`  {bold}${num} ${t.title}{/bold}`);

    // Agent + dependencies
    const depParts: string[] = [];
    if (t.dependsOn?.length > 0) {
      const depNums = t.dependsOn.map((dep: string) => {
        const idx = tasks.findIndex((tt: any) => tt.title === dep);
        return idx >= 0 ? (circled[idx] ?? `#${idx + 1}`) : dep;
      });
      depParts.push(`⟵ ${depNums.join(", ")}`);
    }
    const depStr = depParts.length > 0 ? `  {grey-fg}${depParts.join("  ")}{/grey-fg}` : "";
    lines.push(`    {cyan-fg}→ ${t.assignTo || "default"}{/cyan-fg}${depStr}`);

    // Description (truncated)
    if (t.description && t.description !== t.title) {
      const desc = t.description.length > 120
        ? t.description.slice(0, 117) + "..."
        : t.description;
      lines.push(`    {grey-fg}${desc}{/grey-fg}`);
    }

    // Expectations
    if (t.expectations?.length > 0) {
      const exps = t.expectations.map((e: any) => {
        switch (e.type) {
          case "test": return `{green-fg}☐{/green-fg} test: ${e.command || ""}`;
          case "file_exists": return `{green-fg}☐{/green-fg} files: ${(e.paths || []).join(", ")}`;
          case "script": return `{green-fg}☐{/green-fg} script: ${e.command || ""}`;
          case "llm_review": return `{green-fg}☐{/green-fg} review: ${e.criteria || ""}`;
          default: return `{green-fg}☐{/green-fg} ${e.type}`;
        }
      });
      lines.push(`    ${exps.join("  ")}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}
