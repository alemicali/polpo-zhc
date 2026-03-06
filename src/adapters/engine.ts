/**
 * Polpo Engine — the built-in agentic runtime.
 *
 * Uses @mariozechner/pi-agent-core Agent class for the agentic loop,
 * with pi-ai for multi-provider LLM abstraction.
 * Works with any LLM provider (Anthropic, OpenAI, Google, Groq, etc.)
 */

import type { AgentConfig, AgentActivity, Task, TaskResult, TaskOutcome, OutcomeType } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import { resolveAgentVault } from "../vault/index.js";

/** Create a fresh AgentActivity object */
export function createActivity(): AgentActivity {
  return {
    filesCreated: [],
    filesEdited: [],
    toolCalls: 0,
    totalTokens: 0,
    lastUpdate: new Date().toISOString(),
  };
}
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { join, sep } from "node:path";
import { resolveModel, resolveApiKeyAsync, enforceModelAllowlist } from "../llm/pi-client.js";
import { createCodingTools, createAllTools } from "../tools/coding-tools.js";
import { loadAgentSkills, buildSkillPrompt } from "../llm/skills.js";
import { McpClientManager } from "../mcp/client.js";
import type { McpServerConfig } from "../mcp/types.js";
import { nanoid } from "nanoid";

/**
 * Build an "## Available Tools" section for the agent's system prompt.
 *
 * Lists every tool the agent has access to, grouped by category, so the agent
 * knows its full capabilities upfront. Without this, the agent only discovers
 * tools through the LLM tool-calling protocol and may resort to shell commands,
 * npm installs, or manual workarounds for capabilities it already has.
 *
 * Mirrors the orchestrator-side `describeAgentCapabilities()` in prompts.ts
 * but is more detailed — written for the agent itself, not the orchestrator.
 */
function describeToolsForAgent(agent: AgentConfig): string {
  const lines: string[] = ["## Available Tools", ""];

  // --- Core tools (always present) ---
  lines.push(
    "**Core (always available):**",
    "- `read` — read file contents (supports offset/limit for large files)",
    "- `write` — create or overwrite files",
    "- `edit` — surgical string replacement in files (preferred over rewriting entire files)",
    "- `bash` — execute shell commands (30s default timeout; pass explicit timeout for long commands)",
    "- `glob` — find files by pattern (e.g. `**/*.ts`)",
    "- `grep` — search file contents by regex",
    "- `ls` — list directory contents",
    "- `http_fetch` — make HTTP requests (GET, POST, PUT, DELETE)",
    "- `http_download` — download files from URLs",
    "- `register_outcome` — declare task deliverables (files, URLs, text, data)",
    "- `vault_get` — retrieve stored credentials/secrets",
    "- `vault_list` — list available vault entries",
  );

  // --- Extended tools (only if configured in allowedTools) ---
  const allowed = agent.allowedTools ?? [];
  const hasPattern = (prefix: string) => allowed.some(t => t.toLowerCase().startsWith(prefix));

  const extended: string[] = [];

  if (hasPattern("browser_")) {
    extended.push(
      "",
      "**Browser (agent-browser):**",
      "- `browser_navigate` — open a URL",
      "- `browser_snapshot` — capture page accessibility snapshot",
      "- `browser_click` / `browser_fill` / `browser_select` — interact with page elements",
      "- `browser_eval` — run JavaScript in the page",
      "- `browser_screenshot` — take a screenshot",
      "- Plus: browser_scroll, browser_back, browser_forward, browser_wait, browser_tabs, browser_tab_new, browser_tab_close, browser_tab_switch, browser_pdf, browser_drag, browser_hover, browser_keypress",
      "Use browser tools instead of curl/wget for pages that require JavaScript rendering or authentication.",
    );
  }

  if (hasPattern("email_")) {
    extended.push(
      "",
      "**Email:**",
      "- `email_send` — send an email (WARNING: irreversible side effect)",
      "- `email_draft` — create a draft without sending",
      "- `email_list` — list inbox messages",
      "- `email_read` — read a specific email",
      "- `email_search` — search emails by query",
      "- `email_verify` — verify an email address",
      "ALWAYS use these tools for email operations. Never use bash/curl to send emails.",
    );
  }

  if (hasPattern("whatsapp_")) {
    extended.push(
      "",
      "**WhatsApp:**",
      "- `whatsapp_send` — send a WhatsApp message (WARNING: irreversible side effect)",
      "- `whatsapp_list` — list recent conversations",
      "- `whatsapp_read` — read messages in a conversation",
      "- `whatsapp_search` — search messages",
      "- `whatsapp_contacts` — list contacts",
    );
  }

  if (hasPattern("image_")) {
    extended.push(
      "",
      "**Image:**",
      "- `image_generate` — generate images with AI (fal.ai FLUX)",
      "- `image_analyze` — analyze/describe images with vision models",
    );
  }

  if (hasPattern("video_")) {
    extended.push(
      "",
      "**Video:**",
      "- `video_generate` — generate video with AI (fal.ai Wan 2.2)",
    );
  }

  if (hasPattern("audio_")) {
    extended.push(
      "",
      "**Audio:**",
      "- `audio_transcribe` — speech-to-text (Whisper / Deepgram Nova)",
      "- `audio_speak` — text-to-speech (OpenAI / Deepgram / ElevenLabs / Edge)",
    );
  }

  if (hasPattern("excel_")) {
    extended.push(
      "",
      "**Excel:**",
      "- `excel_read` — read spreadsheet data",
      "- `excel_write` — write/create spreadsheets",
      "- `excel_query` — query spreadsheet data with SQL-like syntax",
      "- `excel_info` — get spreadsheet metadata",
      "Use these instead of installing npm packages for spreadsheet operations.",
    );
  }

  if (hasPattern("pdf_")) {
    extended.push(
      "",
      "**PDF:**",
      "- `pdf_read` — extract text from PDFs",
      "- `pdf_create` — create PDF documents",
      "- `pdf_merge` — merge multiple PDFs",
      "- `pdf_info` — get PDF metadata",
      "Use these instead of installing npm packages for PDF operations.",
    );
  }

  if (hasPattern("docx_")) {
    extended.push(
      "",
      "**Word Documents:**",
      "- `docx_read` — read .docx file contents",
      "- `docx_create` — create .docx documents",
    );
  }

  if (hasPattern("search_")) {
    extended.push(
      "",
      "**Web Search (Exa AI):**",
      "- `search_web` — search the web for information",
      "- `search_find_similar` — find pages similar to a given URL",
      "Use these for research instead of scraping or manual browsing.",
    );
  }

  if (extended.length > 0) {
    lines.push(...extended);
  }

  // --- MCP servers (tools discovered at runtime) ---
  if (agent.mcpServers && Object.keys(agent.mcpServers).length > 0) {
    const serverNames = Object.keys(agent.mcpServers);
    lines.push(
      "",
      "**MCP Servers (external tools):**",
      `Connected MCP servers: ${serverNames.join(", ")}`,
      "These provide additional tools discovered at runtime. Use them when relevant to your task.",
    );
  }

  // --- Guidance ---
  lines.push(
    "",
    "**IMPORTANT:** ALWAYS prefer your available tools over shell commands, npm installs, or manual workarounds.",
    "For example: use `email_send` not `curl`; use `pdf_read` not `pip install PyPDF2`; use `excel_read` not `npm install xlsx`.",
    "If a task requires a capability you don't have listed above, use `bash` as a fallback.",
  );

  return lines.join("\n");
}

/**
 * Build the system prompt for the agent, including loaded skills.
 */
export function buildSystemPrompt(agent: AgentConfig, cwd: string, polpoDir?: string, outputDir?: string, allowedPaths?: string[]): string {
  const parts = [
    "You are a coding agent managed by Polpo, an AI agent orchestrator.",
    "Complete your assigned task autonomously. Make reasonable decisions and proceed without asking questions.",
    "",
    "Your task description may include context tags:",
    "- <project-memory> — persistent project knowledge from previous sessions",
    "- <system-context> — standing instructions from the project owner",
    "- <plan-context> — the plan goal and other tasks being worked on in parallel",
    "Use this context to make better decisions, but focus on YOUR assigned task.",
  ];
  // Identity block
  if (agent.identity) {
    parts.push("", "## Your Identity");
    if (agent.identity.displayName) parts.push(`- Name: ${agent.identity.displayName}`);
    if (agent.identity.title) parts.push(`- Title: ${agent.identity.title}`);
    if (agent.identity.company) parts.push(`- Company: ${agent.identity.company}`);
    if (agent.identity.email) parts.push(`- Email: ${agent.identity.email}`);
    if (agent.identity.bio) parts.push(`- Bio: ${agent.identity.bio}`);
    if (agent.identity.timezone) parts.push(`- Timezone: ${agent.identity.timezone}`);
    if (agent.identity.socials && Object.keys(agent.identity.socials).length > 0) {
      const entries = Object.entries(agent.identity.socials).map(([k, v]) => `${k}: ${v}`).join(", ");
      parts.push(`- Socials: ${entries}`);
    }
    parts.push("Use this identity when communicating externally (emails, messages, etc.).");
  }

  // Responsibilities (detailed, richer than role) — supports both strings and structured objects
  if (agent.identity?.responsibilities?.length) {
    parts.push("", "## Your Responsibilities");
    for (const r of agent.identity.responsibilities) {
      if (typeof r === "string") {
        parts.push(`- ${r}`);
      } else {
        const prio = r.priority ? ` [${r.priority}]` : "";
        parts.push(`- **${r.area}**${prio}: ${r.description}`);
      }
    }
    parts.push("Focus on these responsibilities. Escalate if something falls outside your scope.");
  }

  // Communication tone — HOW the agent communicates
  if (agent.identity?.tone) {
    parts.push("", "## Communication Style");
    parts.push(agent.identity.tone);
  }

  // Personality — WHO the agent IS
  if (agent.identity?.personality) {
    parts.push("", "## Personality");
    parts.push(agent.identity.personality);
  }

  // Hierarchy — who this agent reports to
  if (agent.reportsTo) {
    parts.push("", "## Organization");
    parts.push(`You report to: ${agent.reportsTo}`);
    parts.push("If you encounter blockers or decisions outside your authority, escalate to your manager.");
  }

  if (agent.systemPrompt) parts.push("", agent.systemPrompt);

  // Load and inject skills
  if (polpoDir) {
    const skills = loadAgentSkills(cwd, polpoDir, agent.name, agent.skills);
    const skillBlock = buildSkillPrompt(skills);
    if (skillBlock) parts.push("", skillBlock);
  }

  // Available tools — enumerate what the agent can use so it doesn't resort to
  // shell scripts, npm installs, or manual workarounds for capabilities it already has.
  const toolSection = describeToolsForAgent(agent);
  if (toolSection) parts.push("", toolSection);

  // Working directory — tell the agent where it is so it uses correct relative paths
  parts.push(
    "",
    "## Working Directory",
    `Your working directory is: ${cwd}`,
    "All file tools (read, write, edit, glob, grep, ls) and bash resolve paths relative to this directory.",
    "Use relative paths from here — do NOT prepend the workspace directory name to your paths.",
    "For example, if your cwd is /data/project/workspace, use `brand/file.html` NOT `workspace/brand/file.html`.",
  );

  // Output directory for task deliverables
  if (outputDir) {
    parts.push(
      "",
      "## Output Directory",
      `Your task output directory is: ${outputDir}`,
      "Write all deliverable files (reports, images, data exports, etc.) to this directory.",
      "When you register an outcome with register_outcome, use paths inside this directory.",
      "This directory is pre-created and writable. Other tasks have separate output directories.",
    );
  }

  // Sandbox boundaries — tell the agent exactly where it can read/write.
  // Without this, agents waste tokens trying /tmp, /home, etc. and hitting sandbox errors.
  const sandboxDirs = allowedPaths ?? [cwd];
  parts.push(
    "",
    "## File Access Sandbox",
    `You can ONLY read and write files within these directories:`,
    ...sandboxDirs.map(p => `- ${p}`),
    "Any file operation outside these paths will be REJECTED.",
    "Do NOT use /tmp, /home, or any other directory. Use your working directory or output directory for temporary files.",
  );

  return parts.join("\n");
}

/**
 * Build the user prompt from task data.
 */
function buildPrompt(task: Task): string {
  const parts = [`Task: ${task.title}`, ``, task.description];
  if (task.expectations.length > 0) {
    parts.push(``, `Acceptance criteria:`);
    for (const exp of task.expectations) {
      if (exp.type === "test") parts.push(`- Tests must pass: ${exp.command}`);
      if (exp.type === "file_exists") parts.push(`- Files must exist: ${exp.paths?.join(", ")}`);
      if (exp.type === "script") parts.push(`- Script must pass: ${exp.command}`);
      if (exp.type === "llm_review") parts.push(`- Code review criteria: ${exp.criteria}`);
    }
  }
  parts.push(
    ``,
    `IMPORTANT — Orchestration contract:`,
    `- You are being orchestrated by a supervisor. Complete the task autonomously and EXIT.`,
    `- Do NOT ask clarifying questions. Make reasonable decisions and proceed.`,
    `- You MUST terminate after completing your work. Never block indefinitely.`,
    `- Your session has a timeout. If you hang, you will be killed and the task will fail.`,
    ``,
    `CRITICAL — Bash tool rules:`,
    `- The bash tool has a default timeout of 30 seconds. Commands that exceed it are killed.`,
    `- For long commands (npm install, builds, etc.), pass an explicit timeout: {"command": "...", "timeout": 120000}`,
    `- NEVER run a server or long-lived process in the foreground. It will block forever and kill your session.`,
    `- To start a background server, ALWAYS use this exact pattern:`,
    `  {"command": "nohup python3 server.py > /tmp/server.log 2>&1 & echo \"PID=$!\"", "timeout": 5000}`,
    `  Then verify separately: {"command": "sleep 2 && curl -s --max-time 5 http://127.0.0.1:PORT/", "timeout": 10000}`,
    `- NEVER combine server start + verification in one command (e.g. "cmd & sleep 2 && lsof" WILL hang).`,
    `- NEVER use "lsof" or "netstat" to check if a server is running. Use "curl" instead.`,
    `- NEVER use "tail -f", "watch", or any command that runs forever.`,
    `- If a command times out, do NOT retry the same command. Analyze why it hung and fix the approach.`,
    ``,
    `CRITICAL — Outcome tracking:`,
    `When you produce artifacts (files, reports, data), the orchestrator attaches them to`,
    `task-done notifications (Telegram, Slack, etc.) and approval reviews.`,
    `Outcomes are NEVER auto-collected — you MUST explicitly register every deliverable.`,
    ``,
    `Use the register_outcome tool to declare artifacts as task outcomes:`,
    `  register_outcome({type: 'file', label: 'Sales Report', path: 'output/report.pdf'})`,
    `  register_outcome({type: 'media', label: 'Chart', path: 'charts/revenue.png'})`,
    `  register_outcome({type: 'url', label: 'Staging Deploy', url: 'https://staging.example.com'})`,
    `  register_outcome({type: 'text', label: 'Summary', text: 'Revenue increased 23%...'})`,
    `  register_outcome({type: 'json', label: 'Metrics', data: {revenue: 1234, growth: 0.23}})`,
    ``,
    `RULES:`,
    `  - ALWAYS call register_outcome for every artifact you produce — files, reports, screenshots,`,
    `    downloads, generated media, transcriptions, analysis results, URLs, data summaries`,
    `  - Producing a file (via write, pdf_create, bash, etc.) does NOT auto-register it as an outcome`,
    `  - Only register final deliverables — not intermediate/temporary files`,
    `  - If the task has expectedOutcomes defined, ensure you register matching outcomes`,
  );
  return parts.join("\n");
}

/**
 * Spawn an agent using Polpo's built-in engine (Pi Agent).
 *
 * This is the default execution path — used when no adapter is specified
 * on an agent config.
 */
export function spawnEngine(agentConfig: AgentConfig, task: Task, cwd: string, ctx?: SpawnContext): AgentHandle {
  const activity = createActivity();
  const start = Date.now();
  let alive = true;

  // Enforce model allowlist (throws if model not allowed)
  if (agentConfig.model) {
    enforceModelAllowlist(agentConfig.model);
  }

  // Resolve model
  const model = resolveModel(agentConfig.model);

  // Create all tools scoped to working directory with path sandboxing
  // Core tools (always available): read, write, edit, bash, glob, grep, ls, http_fetch, http_download, register_outcome, vault_get, vault_list
  // Extended tools are auto-loaded when their names appear in allowedTools (e.g. "browser_*", "email_*", "image_*", "video_*", "audio_*", "excel_*", "pdf_*", "docx_*", "search_*")
  // polpoDir must always be provided via SpawnContext.
  // Fallback to join(cwd, ".polpo") is WRONG when settings.workDir points to a
  // subdirectory — cwd would be e.g. /project/packages/app while .polpo/ lives
  // at /project/.polpo/.  Throw early to catch misconfiguration.
  if (!ctx?.polpoDir) {
    throw new Error("spawnEngine: ctx.polpoDir is required (cannot derive .polpo from cwd when settings.workDir is set)");
  }
  const polpoDir = ctx.polpoDir;

  // Browser profile directory for agent-browser persistent state (cookies, auth, localStorage)
  const browserProfileDir = join(polpoDir, "browser-profiles", agentConfig.browserProfile || agentConfig.name);

  // Check if extended tools (browser, email, image, video, audio, excel, pdf, docx) are requested via allowedTools
  // Note: vault tools are now core — always available, no need to check here.
  const hasExtendedTools = agentConfig.allowedTools?.some(t => {
    const lc = t.toLowerCase();
    return lc.startsWith("browser_") || lc.startsWith("email_")
      || lc.startsWith("image_") || lc.startsWith("video_") || lc.startsWith("audio_")
      || lc.startsWith("excel_") || lc.startsWith("pdf_") || lc.startsWith("docx_")
      || lc.startsWith("search_") || lc.startsWith("whatsapp_");
  }) ?? false;

  // Derive output directory from context (per-task output dir for deliverables)
  const outputDir = ctx?.outputDir;

  // Build effective allowed paths, preserving the resolveAllowedPaths default behavior.
  //
  // When allowedPaths is NOT configured (the common case), we leave it undefined so
  // resolveAllowedPaths defaults to [cwd]. But outputDir (.polpo/output/<taskId>)
  // may live outside cwd when settings.workDir points to a subdirectory, so we
  // must add it explicitly in that case.
  //
  // When allowedPaths IS configured, we append outputDir so the agent can write
  // deliverables regardless of its sandbox.
  //
  // BUG FIX: Previously, `agentConfig.allowedPaths ?? []` turned undefined into [],
  // producing [outputDir] as the ONLY allowed path — locking the agent out of its
  // own working directory.
  let effectiveAllowedPaths: string[] | undefined;
  if (agentConfig.allowedPaths) {
    // Explicit sandbox — append outputDir so deliverables are always writable
    effectiveAllowedPaths = [...agentConfig.allowedPaths, ...(outputDir ? [outputDir] : [])];
  } else if (outputDir && !outputDir.startsWith(cwd + sep) && outputDir !== cwd) {
    // No explicit sandbox, but outputDir is outside cwd — add both
    effectiveAllowedPaths = [cwd, outputDir];
  } else {
    // No explicit sandbox, outputDir under cwd (or absent) — let resolveAllowedPaths default to [cwd]
    effectiveAllowedPaths = undefined;
  }

  // Resolve agent vault credentials upfront — vault tools are core (always available)
  const vaultEntries = ctx?.vaultStore?.getAllForAgent(agentConfig.name);
  const vault = resolveAgentVault(vaultEntries);

  // Start with core coding tools (sync); extended tools loaded async in the run phase
  // Vault is passed here so vault_get/vault_list are available from the start
  const codingTools = createCodingTools(cwd, agentConfig.allowedTools, effectiveAllowedPaths, outputDir, vault);

  // MCP client manager — initialized later (async) if mcpServers are configured
  let mcpManager: McpClientManager | null = null;
  const hasMcp = agentConfig.mcpServers && Object.keys(agentConfig.mcpServers).length > 0;

  // Resolve reasoning level: agent config > global settings (via SpawnContext) > "off"
  const thinkingLevel = agentConfig.reasoning ?? ctx?.reasoning ?? "off";

  // Create the pi-agent-core Agent (starts with coding tools only; MCP tools added before prompt)
  // Pass model.maxTokens to override pi-ai's 32K default cap, so each model uses its full output capacity.
  const agent = new Agent({
    getApiKey: (provider: string) => resolveApiKeyAsync(provider),
    initialState: {
      systemPrompt: buildSystemPrompt(agentConfig, cwd, ctx?.polpoDir, outputDir, effectiveAllowedPaths),
      model,
      thinkingLevel,
      maxTokens: model.maxTokens,
      tools: codingTools,
      messages: [],
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set(),
    } as any,
  });

  const handle: AgentHandle = {
    agentName: agentConfig.name,
    taskId: task.id,
    startedAt: new Date().toISOString(),
    pid: 0, // No OS process — runs in-process
    activity,
    done: null as any, // set below
    isAlive: () => alive,
    kill: () => {
      agent.abort();
      alive = false;
      // Best-effort MCP cleanup on kill
      if (mcpManager) mcpManager.close().catch(() => {});
    },
  };

  // Track turns for maxTurns enforcement
  let turnCount = 0;
  const maxTurns = agentConfig.maxTurns ?? 150;

  // Subscribe to agent events for activity tracking + transcript
  agent.subscribe((event: AgentEvent) => {
    activity.lastUpdate = new Date().toISOString();

    switch (event.type) {
      case "message_end": {
        const msg = event.message;
        if (msg && "content" in msg && msg.role === "assistant") {
          // Accumulate token usage
          if ("usage" in msg && msg.usage && typeof msg.usage === "object") {
            const u = msg.usage as { totalTokens?: number };
            if (u.totalTokens) activity.totalTokens += u.totalTokens;
          }
          for (const block of msg.content) {
            if (block.type === "text") {
              activity.summary = block.text.slice(0, 200);
              handle.onTranscript?.({ type: "assistant", text: block.text });
            }
            if (block.type === "toolCall") {
              activity.toolCalls++;
              activity.lastTool = block.name;
              handle.onTranscript?.({
                type: "tool_use",
                tool: block.name,
                toolId: block.id,
                input: block.arguments,
              });
            }
          }
        }
        break;
      }
      case "tool_execution_end": {
        // Track file operations from tool details
        const details = event.result?.details;
        if (details?.path) {
          const filePath = details.path as string;
          activity.lastFile = filePath;
          if (event.toolName === "write" && !activity.filesCreated.includes(filePath)) {
            activity.filesCreated.push(filePath);
          }
          if (event.toolName === "edit" && !activity.filesEdited.includes(filePath)) {
            activity.filesEdited.push(filePath);
          }
        }

        // Collect outcomes from explicit register_outcome calls
        if (!event.isError && details) {
          const outcome = collectOutcome(event.toolName, details);
          if (outcome) {
            if (!handle.outcomes) handle.outcomes = [];
            handle.outcomes.push(outcome);
          }
        }

        // Emit tool result transcript
        const resultText = event.result?.content?.map((c: any) => c.text ?? "").join("") ?? "";
        handle.onTranscript?.({
          type: "tool_result",
          toolId: event.toolCallId,
          tool: event.toolName,
          content: resultText.slice(0, 2000),
          isError: event.isError,
        });
        break;
      }
      case "turn_end": {
        turnCount++;
        if (turnCount >= maxTurns) {
          agent.abort();
        }
        break;
      }
    }
  });

  // Run the agent and capture result
  handle.done = (async (): Promise<TaskResult> => {
    try {
      // Resolve all tools (browser/email auto-detected from allowedTools) and MCP servers before prompting
      // Note: vault is already resolved above and included in codingTools as core tools
      let allTools = codingTools;
      if (hasExtendedTools) {
        allTools = await createAllTools({
          cwd,
          allowedTools: agentConfig.allowedTools,
          allowedPaths: effectiveAllowedPaths,
          browserSession: agentConfig.name,
          browserProfileDir,
          vault,
          emailAllowedDomains: agentConfig.emailAllowedDomains ?? ctx?.emailAllowedDomains,
          outputDir,
          whatsappStore: ctx?.whatsappStore,
          whatsappSendMessage: ctx?.whatsappSendMessage,
        });
        agent.setTools(allTools);
      }

      // Connect to MCP servers if configured (async — must happen before prompt)
      if (hasMcp) {
        mcpManager = new McpClientManager(cwd);
        const log = (msg: string) => handle.onTranscript?.({ type: "assistant", text: msg });
        await mcpManager.connectAll(
          agentConfig.mcpServers as Record<string, McpServerConfig>,
          log,
          ctx?.mcpToolAllowlist,
        );
        const mcpTools = mcpManager.getTools();
        if (mcpTools.length > 0) {
          // Merge all tools (coding + extended) with MCP tools
          agent.setTools([...allTools, ...mcpTools]);
        }
      }

      const prompt = buildPrompt(task);
      await agent.prompt(prompt);

      // Extract final text from the last assistant message
      const messages = agent.state.messages;
      let resultText = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg && "role" in msg && msg.role === "assistant" && "content" in msg) {
          for (const block of msg.content) {
            if (block.type === "text") {
              resultText = block.text;
              break;
            }
          }
          if (resultText) break;
        }
      }

      alive = false;
      return {
        exitCode: 0,
        stdout: resultText,
        stderr: "",
        duration: Date.now() - start,
      };
    } catch (err) {
      alive = false;
      const msg = err instanceof Error ? err.message : String(err);
      handle.onTranscript?.({ type: "error", message: msg });
      return {
        exitCode: 1,
        stdout: "",
        stderr: msg,
        duration: Date.now() - start,
      };
    } finally {
      // Always disconnect MCP servers on completion/failure
      if (mcpManager) {
        await mcpManager.close().catch(() => {});
      }
      // Close agent-browser session (profile data auto-persisted by --profile)
      if (hasExtendedTools) {
        const { cleanupAgentBrowserSession } = await import("../tools/browser-tools.js");
        await cleanupAgentBrowserSession(agentConfig.name).catch(() => {});
      }
    }
  })();

  return handle;
}

// ─── Outcome Collection ─────────────────────────────
//
// Outcomes are ONLY created via the `register_outcome` tool.
// The agent explicitly decides what artifacts are deliverables.
// No auto-collection from other tools — producing files and
// declaring outcomes are two separate responsibilities.

/** MIME type inference from file extension. */
const EXT_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".json": "application/json",
  ".txt": "text/plain",
  ".html": "text/html",
  ".zip": "application/zip",
};

function guessMime(filePath: string): string | undefined {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return EXT_MIME[ext];
}

/**
 * Create a TaskOutcome from a `register_outcome` tool call.
 * Returns undefined for any other tool — outcome registration is explicit only.
 */
function collectOutcome(toolName: string, details: Record<string, unknown>): TaskOutcome | undefined {
  if (toolName !== "register_outcome" || !details.outcomeType || !details.outcomeLabel) {
    return undefined;
  }

  const outcome: TaskOutcome = {
    id: nanoid(),
    type: details.outcomeType as OutcomeType,
    label: details.outcomeLabel as string,
    producedBy: "register_outcome",
    producedAt: new Date().toISOString(),
  };
  if (details.path) {
    outcome.path = details.path as string;
    outcome.mimeType = (details.outcomeMimeType as string) ?? guessMime(details.path as string);
    if (details.outcomeSize !== undefined) outcome.size = details.outcomeSize as number;
  }
  if (details.outcomeText) outcome.text = details.outcomeText as string;
  if (details.outcomeUrl) outcome.url = details.outcomeUrl as string;
  if (details.outcomeData !== undefined) outcome.data = details.outcomeData;
  if (details.outcomeTags) outcome.tags = details.outcomeTags as string[];
  return outcome;
}
