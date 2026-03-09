#!/usr/bin/env node

import { resolve, dirname } from "node:path";
import { mkdir, access, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { DEFAULT_SERVER_PORT, DEFAULT_SERVER_HOST } from "../core/constants.js";

// Read version from package.json at build time fallback
const __dirname_cli = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname_cli, "..", "..", "package.json");
const PKG_VERSION = existsSync(pkgPath)
  ? JSON.parse(readFileSync(pkgPath, "utf-8")).version
  : "0.0.0";

// Load .env files from process.cwd() (project-local, then .polpo/.env).
// NOTE: This runs at module top-level, before --dir is parsed. When --dir differs
// from cwd, the correct .env is loaded later via parseConfig/provider overrides.
for (const envPath of [".env", ".polpo/.env"]) {
  try {
    const abs = resolve(envPath);
    if (existsSync(abs)) {
      for (const line of readFileSync(abs, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch { /* ignore */ }
}
import chalk from "chalk";
// generatePolpoConfigDefault + savePolpoConfig used via dynamic import in setup.ts
import { Orchestrator } from "../core/orchestrator.js";
import type { PolpoState, Task, TaskStatus } from "../core/types.js";

import { registerTaskCommands } from "./commands/task.js";
import { registerMissionCommands } from "./commands/mission.js";
import { registerTeamCommands } from "./commands/team.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerLogsCommands } from "./commands/logs.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerChatCommands } from "./commands/chat.js";
import { registerPlaybookCommands } from "./commands/playbook.js";
import { registerSkillsCommands } from "./commands/skills.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerModelsCommands } from "./commands/models.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerBrowserCommands } from "./commands/browser-profile.js";
import { registerScheduleCommands } from "./commands/schedule.js";
import { registerAgentOnboardCommands } from "./commands/agent-onboard.js";
import { registerUpdateCommand } from "./commands/update.js";
import { registerWhatsAppCommands } from "./commands/whatsapp.js";
import { registerInkCommands } from "./commands/ink.js";
import { ensureSetup } from "./ensure-setup.js";
import { startUpdateCheck } from "./update-check.js";

/** Wire orchestrator events to console output with chalk formatting. */
function wireConsoleEvents(orchestrator: Orchestrator): void {
  orchestrator.on("orchestrator:started", ({ org, agents }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.bold(`Polpo started — ${org}`)}`);
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.dim(`Team agents: ${agents.join(", ")}`)}`);
    console.log();
  });

  orchestrator.on("task:created", ({ task }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.cyan(`[${task.id}] Task added: ${task.title}`)}`);
  });

  orchestrator.on("agent:spawned", ({ taskId, agentName, taskTitle }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.blue(`[${taskId}] Spawning "${agentName}" for: ${taskTitle}`)}`);
  });

  orchestrator.on("agent:finished", ({ taskId, exitCode, duration }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` [${taskId}] Agent finished — exit ${exitCode} (${(duration / 1000).toFixed(1)}s)`);
  });

  orchestrator.on("assessment:complete", ({ taskId, passed, globalScore, message }) => {
    const ts = new Date().toLocaleTimeString();
    const scoreInfo = globalScore !== undefined ? ` (score: ${globalScore.toFixed(1)}/5)` : "";
    if (passed) {
      console.log(chalk.dim(`[${ts}]`) + ` ${chalk.green(`[${taskId}] PASSED${scoreInfo} — ${message}`)}`);
    } else {
      console.log(chalk.dim(`[${ts}]`) + ` ${chalk.red(`[${taskId}] FAILED${scoreInfo} — ${message}`)}`);
    }
  });

  orchestrator.on("task:transition", ({ taskId, to, task }) => {
    if (to === "done") {
      const ts = new Date().toLocaleTimeString();
      console.log(chalk.dim(`[${ts}]`) + ` ${chalk.green(`[${taskId}] DONE — ${task.title}`)}`);
    }
  });

  orchestrator.on("task:retry", ({ taskId, attempt, maxRetries }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.yellow(`[${taskId}] Retrying (${attempt}/${maxRetries})...`)}`);
  });

  orchestrator.on("task:retry:blocked", ({ taskId, reason }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.yellow(`[${taskId}] ⚠ Retry blocked: ${reason}`)}`);
  });

  orchestrator.on("task:maxRetries", ({ taskId }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.red(`[${taskId}] Max retries reached — giving up`)}`);
  });

  orchestrator.on("orchestrator:deadlock", () => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.red("Deadlock detected: tasks have unresolvable dependencies.")}`);
  });

  orchestrator.on("orchestrator:shutdown", () => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.dim("Polpo shut down cleanly.")}`);
  });

  orchestrator.on("task:recovered", ({ title, previousStatus }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.yellow(`Recovering orphaned task: "${title}" (was ${previousStatus})`)}`);
  });

  orchestrator.on("log", ({ level, message }) => {
    const ts = new Date().toLocaleTimeString();
    const color = level === "error" ? chalk.red
      : level === "warn" ? chalk.yellow
      : chalk.dim;
    console.log(chalk.dim(`[${ts}]`) + ` ${color(message)}`);
  });

  orchestrator.on("checkpoint:reached", ({ group, checkpointName, message }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.yellow(`[${group}] Checkpoint reached: "${checkpointName}"${message ? ` — ${message}` : ""}`)}`);
  });

  orchestrator.on("checkpoint:resumed", ({ group, checkpointName }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.green(`[${group}] Checkpoint resumed: "${checkpointName}"`)}`);
  });

  orchestrator.on("delay:started", ({ group, delayName, duration, message }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.blue(`[${group}] Delay started: "${delayName}" (${duration})${message ? ` — ${message}` : ""}`)}`);
  });

  orchestrator.on("delay:expired", ({ group, delayName }) => {
    const ts = new Date().toLocaleTimeString();
    console.log(chalk.dim(`[${ts}]`) + ` ${chalk.green(`[${group}] Delay expired: "${delayName}" — blocked tasks unblocked`)}`);
  });
}

// Gradient from pink (#F78B97) to indigo (#3B3E73) — 6 rows
const _logoLines = [
  "██████╗  ██████╗ ██╗     ██████╗  ██████╗",
  "██╔══██╗██╔═══██╗██║     ██╔══██╗██╔═══██╗",
  "██████╔╝██║   ██║██║     ██████╔╝██║   ██║",
  "██╔═══╝ ██║   ██║██║     ██╔═══╝ ██║   ██║",
  "██║     ╚██████╔╝███████╗██║     ╚██████╔╝",
  "╚═╝      ╚═════╝ ╚══════╝╚═╝      ╚═════╝",
];
const _gradColors: [number, number, number][] = [
  [247, 139, 151], // #F78B97
  [209, 119, 135],
  [170, 99, 119],
  [132, 79, 103],
  [93, 59, 87],
  [59, 62, 115],   // #3B3E73
];
function _buildLogo(center = false): string {
  const cols = process.stdout.columns || 80;
  return "\n" + _logoLines.map((l, i) => {
    const pad = center ? " ".repeat(Math.max(0, Math.floor((cols - l.length) / 2))) : "  ";
    return pad + chalk.bold.rgb(..._gradColors[i])(l);
  }).join("\n") + "\n";
}
const LOGO = _buildLogo(false);
const LOGO_CENTER = () => _buildLogo(true);

const LOGO_MINI = `  ${chalk.bold.white("🐙 P O L P O")}  `;

const program = new Command();

program
  .name("polpo")
  .description("Agent-agnostic framework for orchestrating teams of AI coding agents")
  .version(PKG_VERSION);

// polpo init
program
  .command("init")
  .description("Initialize Polpo in the current project")
  .option("-d, --dir <path>", "Working directory", ".")
  .action(async (opts) => {
    console.log(LOGO_CENTER());

    const workDir = resolve(opts.dir);
    const polpoDir = resolve(workDir, ".polpo");

    await mkdir(polpoDir, { recursive: true });
    await mkdir(resolve(polpoDir, "logs"), { recursive: true });
    await mkdir(resolve(polpoDir, "assessments"), { recursive: true });

    // Create .polpo/polpo.json via setup wizard (or non-interactive fallback)
    const polpoJsonPath = resolve(polpoDir, "polpo.json");
    try {
      await access(polpoJsonPath);
      console.log(chalk.yellow("  .polpo/polpo.json already exists."));
      console.log(chalk.dim("  Run 'polpo setup' to reconfigure.\n"));
    } catch {
      const { runSetupWizard } = await import("./commands/setup.js");
      await runSetupWizard({ polpoDir, workDir });
    }

    console.log(chalk.green("\n  Polpo initialized!"));
    console.log(chalk.dim("  Run: polpo tui\n"));
  });

// polpo run
program
  .command("run")
  .description("Run the orchestration (execute pending tasks)")
  .option("-d, --dir <path>", "Working directory", ".")
  .action(async (opts) => {
    console.log(LOGO);
    try {
      const orchestrator = new Orchestrator(opts.dir);
      wireConsoleEvents(orchestrator);
      await orchestrator.run();
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// polpo status
program
  .command("status")
  .description("Show current task status (live dashboard)")
  .option("-d, --dir <path>", "Working directory", ".")
  .option("-w, --watch", "Watch mode: auto-refresh", false)
  .action(async (opts) => {
    const statePath = resolve(opts.dir, ".polpo", "state.json");
    let frame = 0;
    const startTime = Date.now();
    let lastState: PolpoState | null = null;

    const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const PULSE  = ["●", "◉", "○", "◉"];

    const printStatus = async () => {
      if (!existsSync(statePath)) {
        console.log(chalk.red("  No .polpo/state.json found. Run 'polpo init' first."));
        return;
      }

      try {
        const raw = await readFile(statePath, "utf-8");
        lastState = JSON.parse(raw);
      } catch { /* file being written — use last state */
      }

      const state = lastState;
      if (!state) return;

      if (state.tasks.length === 0) {
        console.log(chalk.dim("  No tasks yet."));
        return;
      }

      const spin = SPINNER[frame % SPINNER.length];
      const pulse = PULSE[frame % PULSE.length];

      const getIcon = (status: TaskStatus) => {
        switch (status) {
          case "draft":             return chalk.gray("✎");
          case "pending":           return chalk.gray("○");
          case "awaiting_approval": return chalk.yellow("⏳");
          case "assigned":          return chalk.cyan(pulse);
          case "in_progress":       return chalk.yellow(spin);
          case "review":            return chalk.magenta(spin);
          case "done":              return chalk.green("●");
          case "failed":            return chalk.red("✗");
        }
      };

      const getLabel = (status: TaskStatus) => {
        switch (status) {
          case "draft":             return chalk.gray("DRAFT     ");
          case "pending":           return chalk.gray("PENDING   ");
          case "awaiting_approval": return chalk.yellow("APPROVAL  ");
          case "assigned":          return chalk.cyan("ASSIGNED  ");
          case "in_progress":       return chalk.yellow.bold("RUNNING   ");
          case "review":            return chalk.magenta.bold("REVIEW    ");
          case "done":              return chalk.green("DONE      ");
          case "failed":            return chalk.red.bold("FAILED    ");
        }
      };

      const formatTime = (ms: number): string => {
        const sec = Math.round(ms / 1000);
        if (sec < 60) return `${sec}s`;
        const min = Math.floor(sec / 60);
        const s = sec % 60;
        if (min < 60) return `${min}m${s}s`;
        const hr = Math.floor(min / 60);
        const m = min % 60;
        return `${hr}h${m}m`;
      };

      const getElapsed = (task: Task): string => {
        if (task.result) return chalk.dim(formatTime(task.result.duration));
        if (task.status === "in_progress" || task.status === "review" || task.status === "assigned") {
          const ms = Date.now() - new Date(task.updatedAt).getTime();
          return chalk.yellow(formatTime(ms));
        }
        return chalk.dim("-");
      };

      const getFailReason = (task: Task): string => {
        if (task.status !== "failed") return "";
        if (!task.result) {
          const blockedBy = task.dependsOn
            .map(depId => state.tasks.find(t => t.id === depId))
            .filter(t => t && t.status === "failed")
            .map(t => t!.title);
          if (blockedBy.length > 0) return chalk.red(`dependency failed: ${blockedBy.join(", ")}`);
          return chalk.red("never ran");
        }
        if (task.result.assessment) {
          const failedChecks = task.result.assessment.checks.filter(c => !c.passed);
          const failedMetrics = task.result.assessment.metrics.filter(m => !m.passed);
          const reasons = [
            ...failedChecks.map(c => c.message),
            ...failedMetrics.map(m => `${m.name}: ${m.value}/${m.threshold}`),
          ];
          if (reasons.length > 0) return chalk.red(reasons[0]);
        }
        if (task.result.exitCode !== 0) {
          const stderr = task.result.stderr.split("\n").filter(l => l.trim()).pop() || "";
          return chalk.red(`exit ${task.result.exitCode}${stderr ? `: ${stderr.slice(0, 60)}` : ""}`);
        }
        return "";
      };

      // Counts
      const total = state.tasks.length;
      const counts: Record<string, number> = {};
      for (const t of state.tasks) counts[t.status] = (counts[t.status] || 0) + 1;
      const doneCount = counts["done"] || 0;
      const failedCount = counts["failed"] || 0;
      const pendingCount = counts["pending"] || 0;
      const runningCount = (counts["in_progress"] || 0) + (counts["review"] || 0) + (counts["assigned"] || 0);

      const processedCount = doneCount + failedCount;
      const pct = Math.round((processedCount / total) * 100);
      const barLen = 30;
      const greenFill = Math.round((doneCount / total) * barLen);
      const redFill = Math.round((failedCount / total) * barLen);
      const grayFill = barLen - greenFill - redFill;
      const bar = chalk.green("█".repeat(greenFill)) + chalk.red("█".repeat(redFill)) + chalk.gray("░".repeat(Math.max(0, grayFill)));

      const isAllDone = processedCount === total;
      const headerIcon = isAllDone
        ? (failedCount > 0 ? chalk.red("✗") : chalk.green("✓"))
        : chalk.yellow(spin);

      // Elapsed since watch started
      const totalElapsed = formatTime(Date.now() - (state.startedAt ? new Date(state.startedAt).getTime() : startTime));

      // Header
      console.log(`\n  ${headerIcon} ${LOGO_MINI} ${headerIcon}`);
      console.log(chalk.dim(`    ${state.org || "org"} | Teams: ${state.teams.map(t => t.name).join(", ") || "-"} | Agents: ${state.teams.flatMap(t => t.agents).map(a => a.name).join(", ") || "-"}`));
      console.log(chalk.dim(`    Elapsed: ${totalElapsed}`));

      // Progress bar
      const statusParts = [];
      if (doneCount > 0) statusParts.push(chalk.green(`${doneCount} done`));
      if (runningCount > 0) statusParts.push(chalk.yellow(`${runningCount} running`));
      if (pendingCount > 0) statusParts.push(chalk.gray(`${pendingCount} pending`));
      if (failedCount > 0) statusParts.push(chalk.red(`${failedCount} failed`));
      console.log(`\n    ${bar} ${pct}%  ${statusParts.join(chalk.dim(" | "))}\n`);

      // Task list
      for (const task of state.tasks) {
        const icon = getIcon(task.status);
        const label = getLabel(task.status);
        const agent = chalk.dim(`${task.assignTo}`);
        const time = getElapsed(task);
        const retries = task.retries > 0 ? chalk.yellow(` retry ${task.retries}/${task.maxRetries}`) : "";
        const reason = getFailReason(task);

        const proc = (state.processes || []).find(p => p.taskId === task.id);
        const pid = proc && proc.alive ? chalk.dim(` PID:${proc.pid}`) : "";
        const dead = proc && !proc.alive && task.status === "in_progress" ? chalk.red.bold(" DEAD") : "";

        console.log(`    ${icon} ${label} ${task.title}`);
        console.log(chalk.dim(`      agent: ${agent}  time: ${time}${pid}${dead}${retries}`));
        if (reason) console.log(`      ${reason}`);

        // Show live agent activity for running tasks
        if (proc && proc.alive && proc.activity) {
          const act = proc.activity;
          const actParts: string[] = [];
          if (act.lastTool) actParts.push(`tool: ${act.lastTool}`);
          if (act.lastFile) actParts.push(`file: ${act.lastFile}`);
          if (act.toolCalls > 0) actParts.push(`calls: ${act.toolCalls}`);
          if (act.filesCreated.length > 0) actParts.push(`created: ${act.filesCreated.length}`);
          if (act.filesEdited.length > 0) actParts.push(`edited: ${act.filesEdited.length}`);
          if (actParts.length > 0) {
            console.log(chalk.cyan(`      ${spin} ${actParts.join("  ")}`));
          }
          if (act.summary) {
            console.log(chalk.dim(`      "${act.summary.slice(0, 80)}${act.summary.length > 80 ? "..." : ""}"`));
          }
        }

        // Show LLM evaluation scores for completed tasks
        if (task.result?.assessment?.scores && task.result.assessment.scores.length > 0) {
          const a = task.result.assessment;
          const scoreBar = a.scores!.map(s => {
            const stars = "★".repeat(Math.round(s.score)) + "☆".repeat(5 - Math.round(s.score));
            const color = s.score >= 4 ? chalk.green : s.score >= 3 ? chalk.yellow : chalk.red;
            return `${s.dimension}: ${color(stars)}`;
          }).join("  ");
          const globalColor = (a.globalScore ?? 0) >= 4 ? chalk.green : (a.globalScore ?? 0) >= 3 ? chalk.yellow : chalk.red;
          console.log(`      ${scoreBar}`);
          console.log(`      ${globalColor(`Global: ${a.globalScore?.toFixed(1)}/5`)}`);
        } else if (task.result?.assessment?.llmReview && task.status === "done") {
          console.log(chalk.green(`      review: ${task.result.assessment.llmReview.slice(0, 100)}`));
        }
      }

      // Active processes summary
      const aliveProcs = (state.processes || []).filter(p => p.alive);
      if (aliveProcs.length > 0) {
        console.log(chalk.dim(`\n    Active agents: ${aliveProcs.length}`));
      }

      // Footer
      if (isAllDone) {
        if (failedCount > 0) {
          console.log(chalk.red.bold(`\n    Finished: ${doneCount} done, ${failedCount} failed (${totalElapsed})`));
        } else {
          console.log(chalk.green.bold(`\n    All ${total} tasks completed! (${totalElapsed})`));
        }
      }
      console.log();
      frame++;
    };

    if (opts.watch) {
      // Use alternate screen buffer to avoid flicker
      process.stdout.write("\x1B[?1049h"); // enter alt screen
      process.on("SIGINT", () => {
        process.stdout.write("\x1B[?1049l"); // restore screen
        process.exit(0);
      });

      const tick = async () => {
        process.stdout.write("\x1B[H"); // cursor home (no clear)
        await printStatus();
        process.stdout.write("\x1B[J"); // clear from cursor to end
      };
      await tick();
      setInterval(tick, 2000);
    } else {
      console.log(LOGO_MINI);
      await printStatus();
    }
  });

// polpo serve — HTTP API server
program
  .command("serve")
  .description("Start the Polpo HTTP API server")
  .option("-p, --port <port>", "Port to listen on", String(DEFAULT_SERVER_PORT))
  .option("-H, --host <host>", "Host to bind to", DEFAULT_SERVER_HOST)
  .option("-d, --dir <path>", "Working directory", ".")
  .option("--api-key <key>", "API key for authentication (optional)")
  .option("--cors-origins <origins>", "Comma-separated allowed CORS origins (env: POLPO_CORS_ORIGINS)")
  .action(async (opts) => {
    console.log(LOGO);
    const { PolpoServer } = await import("../server/index.js");

    const workDir = resolve(opts.dir);
    const port = parseInt(opts.port, 10);

    const apiKeys = opts.apiKey ? [opts.apiKey] : [];

    const corsRaw = opts.corsOrigins ?? process.env.POLPO_CORS_ORIGINS;
    const corsOrigins = corsRaw
      ? corsRaw.split(",").map((o: string) => o.trim()).filter(Boolean)
      : undefined;

    // Security warning: no authentication configured
    if (apiKeys.length === 0) {
      const isExposed = opts.host === "0.0.0.0" || opts.host === "::";
      console.log(
        chalk.yellow.bold("\n  WARNING: No API key configured — server has no authentication.\n") +
        (isExposed
          ? chalk.yellow(`  The server is binding to ${opts.host} (all interfaces) and is accessible\n`) +
            chalk.yellow("  from the network. Anyone on your network can control your agents.\n\n") +
            chalk.yellow("  To secure it, use: ") + chalk.white("polpo serve --api-key <secret>\n")
          : chalk.dim("  Server is localhost-only. Use --api-key <secret> for network access.\n")),
      );
    }

    const server = new PolpoServer({
      port,
      host: opts.host,
      workDir,
      apiKeys,
      corsOrigins,
    });

    await server.start();
  });

// polpo tui (interactive mode — also the default)
program
  .command("tui", { isDefault: true })
  .description("Launch the interactive TUI (default)")
  .option("-d, --dir <path>", "Working directory", ".")
  .action(async (opts) => {
    const dir = resolve(opts.dir);
    await ensureSetup(dir);
    const { startInkTUI } = await import("../tui/app.js");
    await startInkTUI(dir);
  });

// Register subcommand groups
registerTaskCommands(program);
registerMissionCommands(program);
registerTeamCommands(program);
registerMemoryCommands(program);
registerLogsCommands(program);
registerConfigCommands(program);
registerChatCommands(program);
registerPlaybookCommands(program);
registerSkillsCommands(program);
registerAuthCommands(program);
registerModelsCommands(program);
registerSetupCommand(program);
registerBrowserCommands(program);
registerScheduleCommands(program);
registerAgentOnboardCommands(program);
registerUpdateCommand(program);
registerWhatsAppCommands(program);
registerInkCommands(program);

// Non-blocking update check — prints notice at exit if a new version exists
const printUpdateNotice = startUpdateCheck(PKG_VERSION);
process.on("exit", printUpdateNotice);

program.parse();
