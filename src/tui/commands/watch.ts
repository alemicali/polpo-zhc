/**
 * /watch — Interactive bridge mode for watching Claude Code sessions.
 * Works in both Ink and blessed TUIs.
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { decodeProjectDir } from "../../bridge/tracker.js";
import { BridgeManager } from "../../bridge/index.js";
import { useTUIStore, type LogSeg } from "../store.js";
import type { CommandContext } from "../context.js";
import { createOverlay, addHintBar } from "../widgets.js";
import blessed from "blessed";

// ─── Shared Utility ──────────────────────────────────────

interface ProjectEntry {
  /** Absolute path to the project directory under ~/.claude/projects/ */
  dir: string;
  /** Raw directory name (e.g. "-home-user-project") */
  dirName: string;
  /** Decoded human-readable path (e.g. "/home/user/project") */
  decoded: string;
  /** Number of .jsonl transcript files */
  jsonlCount: number;
}

/** Scan ~/.claude/projects/ for directories containing JSONL transcripts. */
export function scanClaudeProjects(): ProjectEntry[] {
  const claudeDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeDir)) return [];

  const results: ProjectEntry[] = [];
  try {
    const dirs = readdirSync(claudeDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const fullDir = join(claudeDir, d.name);
      try {
        const files = readdirSync(fullDir).filter(f => f.endsWith(".jsonl"));
        if (files.length > 0) {
          results.push({
            dir: fullDir,
            dirName: d.name,
            decoded: decodeProjectDir(d.name),
            jsonlCount: files.length,
          });
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* claude dir not readable */ }

  return results.sort((a, b) => a.decoded.localeCompare(b.decoded));
}

/** Shorthand segment constructor */
const seg = (text: string, color?: string, bold?: boolean, dim?: boolean): LogSeg => ({ text, color, bold, dim });

// ─── Bridge Event Wiring ─────────────────────────────────

function wireBridgeEventsInk(manager: BridgeManager): void {
  const store = useTUIStore.getState();

  manager.emitter.on("bridge:session:discovered", ({ sessionId, projectPath }) => {
    store.logEvent(`  + ${sessionId.slice(0, 8)}... → ${projectPath}`, [
      seg("  "),
      seg("+", "green", true),
      seg(` ${sessionId.slice(0, 8)}...`, undefined, true),
      seg(` → ${projectPath}`, "cyan"),
    ]);
  });

  manager.emitter.on("bridge:session:activity", ({ sessionId, messageCount, toolCalls, filesCreated, filesEdited }) => {
    const parts: string[] = [];
    parts.push(`msgs:${messageCount}`);
    if (toolCalls.length > 0) parts.push(`tools:${toolCalls.length}`);
    if (filesCreated.length > 0) parts.push(`+${filesCreated.length}`);
    if (filesEdited.length > 0) parts.push(`~${filesEdited.length}`);
    store.logEvent(`  ● ${sessionId.slice(0, 8)}... ${parts.join(" ")}`, [
      seg("  "),
      seg("●", "yellow"),
      seg(` ${sessionId.slice(0, 8)}...`, undefined, true),
      seg(` ${parts.join("  ")}`, "gray"),
    ]);
  });

  manager.emitter.on("bridge:session:completed", ({ sessionId, projectPath, duration }) => {
    const dur = duration > 60000 ? `${(duration / 60000).toFixed(1)}m` : `${(duration / 1000).toFixed(0)}s`;
    store.logEvent(`  ✓ ${sessionId.slice(0, 8)}... completed (${dur})`, [
      seg("  "),
      seg("✓", "blue", true),
      seg(` ${sessionId.slice(0, 8)}...`, undefined, true),
      seg(` ${projectPath}`, "cyan"),
      seg(` (${dur})`, "gray"),
    ]);
  });
}

function wireBridgeEventsBlessed(manager: BridgeManager, logger: CommandContext): void {
  manager.emitter.on("bridge:session:discovered", ({ sessionId, projectPath }) => {
    logger.logEvent(`  {green-fg}{bold}+{/bold}{/green-fg} {bold}${sessionId.slice(0, 8)}...{/bold} {cyan-fg}→ ${projectPath}{/cyan-fg}`);
  });

  manager.emitter.on("bridge:session:activity", ({ sessionId, messageCount, toolCalls, filesCreated, filesEdited }) => {
    const parts: string[] = [];
    parts.push(`msgs:${messageCount}`);
    if (toolCalls.length > 0) parts.push(`tools:${toolCalls.length}`);
    if (filesCreated.length > 0) parts.push(`+${filesCreated.length}`);
    if (filesEdited.length > 0) parts.push(`~${filesEdited.length}`);
    logger.logEvent(`  {yellow-fg}●{/yellow-fg} {bold}${sessionId.slice(0, 8)}...{/bold} {grey-fg}${parts.join("  ")}{/grey-fg}`);
  });

  manager.emitter.on("bridge:session:completed", ({ sessionId, projectPath, duration }) => {
    const dur = duration > 60000 ? `${(duration / 60000).toFixed(1)}m` : `${(duration / 1000).toFixed(0)}s`;
    logger.logEvent(`  {blue-fg}{bold}✓{/bold}{/blue-fg} {bold}${sessionId.slice(0, 8)}...{/bold} {cyan-fg}${projectPath}{/cyan-fg} {grey-fg}(${dur}){/grey-fg}`);
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── Ink Handler ──────────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function cmdWatchInk() {
  const store = useTUIStore.getState();

  // If bridge is already active, show status/stop menu
  if (store.bridge) {
    showBridgeStatusInk();
    return;
  }

  const projects = scanClaudeProjects();
  if (projects.length === 0) {
    store.logAlways("No Claude Code projects found in ~/.claude/projects/");
    return;
  }

  const selected = new Set<string>(projects.map(p => p.dir)); // all selected by default
  showProjectPickerInk(projects, selected);
}

function showProjectPickerInk(projects: ProjectEntry[], selected: Set<string>) {
  const store = useTUIStore.getState();

  const items = projects.map(p => ({
    label: `[${selected.has(p.dir) ? chalk.green("✓") : " "}] ${chalk.bold(p.decoded)}  ${chalk.gray(`(${p.jsonlCount} sessions)`)}`,
    value: p.dir,
  }));

  store.openOverlay("picker", {
    title: `Watch — Select projects (${selected.size}/${projects.length})`,
    items,
    borderColor: "green",
    hint: "Space toggle  a all  n none  Enter start  Esc cancel",
    onSelect: () => {
      // Enter = start watching
      store.closeOverlay();
      startBridgeInk(projects, selected);
    },
    onKey: (input: string, _key: any, _idx: number, value: string) => {
      if (input === " ") {
        if (selected.has(value)) selected.delete(value);
        else selected.add(value);
        store.closeOverlay();
        showProjectPickerInk(projects, selected);
      } else if (input === "a") {
        for (const p of projects) selected.add(p.dir);
        store.closeOverlay();
        showProjectPickerInk(projects, selected);
      } else if (input === "n") {
        selected.clear();
        store.closeOverlay();
        showProjectPickerInk(projects, selected);
      }
    },
  });
}

function startBridgeInk(projects: ProjectEntry[], selected: Set<string>) {
  const store = useTUIStore.getState();
  const paths = projects.filter(p => selected.has(p.dir)).map(p => p.dir);

  if (paths.length === 0) {
    store.logAlways("No projects selected");
    return;
  }

  const manager = new BridgeManager({
    watch: { claudeCode: false, opencode: false, paths },
  });

  store.setBridge(manager);
  wireBridgeEventsInk(manager);
  manager.start();

  store.logAlways(`Bridge started — watching ${paths.length} project(s)`, [
    seg("Bridge started", "green", true),
    seg(` — watching ${paths.length} project(s)`, "gray"),
  ]);
}

function showBridgeStatusInk() {
  const store = useTUIStore.getState();
  const bridge = store.bridge!;
  const stats = bridge.getStats();

  const items = [
    { label: chalk.gray(`Sessions: ${stats.total} total, ${stats.active} active, ${stats.completed} completed`), value: "info" },
    { label: chalk.red("Stop watching"), value: "stop" },
  ];

  store.openOverlay("picker", {
    title: "Bridge Status",
    items,
    borderColor: "green",
    onSelect: (_idx: number, value: string) => {
      if (value === "stop") {
        bridge.stop();
        store.setBridge(null);
        store.logAlways("Bridge stopped", [seg("Bridge stopped", "yellow", true)]);
      }
    },
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ─── Blessed Handler ─────────────────────────────────────
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function cmdWatch(ctx: CommandContext) {
  // If bridge is already active, show status/stop menu
  if (ctx.bridge) {
    showBridgeStatusBlessed(ctx);
    return;
  }

  const projects = scanClaudeProjects();
  if (projects.length === 0) {
    ctx.logAlways("No Claude Code projects found in ~/.claude/projects/");
    return;
  }

  const selected = new Set<string>(projects.map(p => p.dir)); // all selected by default
  showProjectPickerBlessed(ctx, projects, selected);
}

function showProjectPickerBlessed(ctx: CommandContext, projects: ProjectEntry[], selected: Set<string>) {
  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const buildItems = () => projects.map(p =>
    `  [${selected.has(p.dir) ? "{green-fg}✓{/green-fg}" : " "}] {bold}${p.decoded}{/bold}  {grey-fg}(${p.jsonlCount} sessions){/grey-fg}`
  );

  const list = blessed.list({
    parent: overlay,
    top: "center",
    left: "center",
    width: "70%",
    height: Math.min(projects.length + 2, 20),
    items: buildItems(),
    tags: true,
    border: { type: "line" },
    label: ` {bold}Watch — Select projects (${selected.size}/${projects.length}){/bold} `,
    style: {
      bg: "black",
      border: { fg: "green" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
  });

  addHintBar(overlay, " {cyan-fg}Space{/cyan-fg} {grey-fg}toggle{/grey-fg}  {cyan-fg}a{/cyan-fg} {grey-fg}all{/grey-fg}  {cyan-fg}n{/cyan-fg} {grey-fg}none{/grey-fg}  {cyan-fg}Enter{/cyan-fg} {grey-fg}start{/grey-fg}  {cyan-fg}Esc{/cyan-fg} {grey-fg}cancel{/grey-fg}");

  list.select(0);
  list.focus();
  ctx.scheduleRender();

  onKeypress((_ch, key) => {
    if (!key) return;

    if (key.name === "up" || key.name === "k") {
      list.up(1);
      ctx.scheduleRender();
    } else if (key.name === "down" || key.name === "j") {
      list.down(1);
      ctx.scheduleRender();
    } else if (key.name === "space") {
      const idx = (list as any).selected ?? 0;
      const project = projects[idx];
      if (project) {
        if (selected.has(project.dir)) selected.delete(project.dir);
        else selected.add(project.dir);
        list.setItems(buildItems());
        list.select(idx);
        ctx.scheduleRender();
      }
    } else if (_ch === "a") {
      for (const p of projects) selected.add(p.dir);
      const idx = (list as any).selected ?? 0;
      list.setItems(buildItems());
      list.select(idx);
      ctx.scheduleRender();
    } else if (_ch === "n") {
      selected.clear();
      const idx = (list as any).selected ?? 0;
      list.setItems(buildItems());
      list.select(idx);
      ctx.scheduleRender();
    } else if (key.name === "return" || key.name === "enter") {
      cleanup();
      startBridgeBlessed(ctx, projects, selected);
    } else if (key.name === "escape") {
      cleanup();
    }
  });
}

function startBridgeBlessed(ctx: CommandContext, projects: ProjectEntry[], selected: Set<string>) {
  const paths = projects.filter(p => selected.has(p.dir)).map(p => p.dir);

  if (paths.length === 0) {
    ctx.logAlways("No projects selected");
    return;
  }

  const manager = new BridgeManager({
    watch: { claudeCode: false, opencode: false, paths },
  });

  ctx.setBridge(manager);
  wireBridgeEventsBlessed(manager, ctx);
  manager.start();

  ctx.logAlways(`{green-fg}{bold}Bridge started{/bold}{/green-fg} {grey-fg}— watching ${paths.length} project(s){/grey-fg}`);
}

function showBridgeStatusBlessed(ctx: CommandContext) {
  const bridge = ctx.bridge!;
  const stats = bridge.getStats();

  const { overlay, cleanup, onKeypress } = createOverlay(ctx);

  const items = [
    `  {grey-fg}Sessions: ${stats.total} total, ${stats.active} active, ${stats.completed} completed{/grey-fg}`,
    `  {red-fg}Stop watching{/red-fg}`,
  ];

  const list = blessed.list({
    parent: overlay,
    top: "center",
    left: "center",
    width: "60%",
    height: items.length + 2,
    items,
    tags: true,
    border: { type: "line" },
    label: " {bold}Bridge Status{/bold} ",
    style: {
      bg: "black",
      border: { fg: "green" },
      selected: { bg: "blue", fg: "white", bold: true },
      item: { bg: "black" },
    },
    keys: false,
    vi: false,
    mouse: true,
  });

  list.select(0);
  list.focus();
  ctx.scheduleRender();

  onKeypress((_ch, key) => {
    if (!key) return;
    if (key.name === "up" || key.name === "k") {
      list.up(1);
      ctx.scheduleRender();
    } else if (key.name === "down" || key.name === "j") {
      list.down(1);
      ctx.scheduleRender();
    } else if (key.name === "return" || key.name === "enter") {
      const idx = (list as any).selected ?? 0;
      cleanup();
      if (idx === 1) {
        bridge.stop();
        ctx.setBridge(null);
        ctx.logAlways("{yellow-fg}{bold}Bridge stopped{/bold}{/yellow-fg}");
      }
    } else if (key.name === "escape") {
      cleanup();
    }
  });
}
