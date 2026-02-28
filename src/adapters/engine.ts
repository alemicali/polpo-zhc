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
import { join } from "node:path";
import { resolveModel, resolveApiKeyAsync, enforceModelAllowlist } from "../llm/pi-client.js";
import { createCodingTools, createAllTools } from "../tools/coding-tools.js";
import { loadAgentSkills, buildSkillPrompt } from "../llm/skills.js";
import { McpClientManager } from "../mcp/client.js";
import type { McpServerConfig } from "../mcp/types.js";
import { nanoid } from "nanoid";

/**
 * Build the system prompt for the agent, including loaded skills.
 */
export function buildSystemPrompt(agent: AgentConfig, cwd: string, polpoDir?: string): string {
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
    `task-done notifications (Telegram, Slack, etc.). Some tools auto-track outcomes, but`,
    `if you generate files via bash scripts or external tools, you MUST register them explicitly.`,
    ``,
    `The register_outcome tool lets you declare any artifact as a task outcome:`,
    `  register_outcome({type: 'file', label: 'Sales Report', path: 'output/report.pdf'})`,
    `  register_outcome({type: 'media', label: 'Chart', path: 'charts/revenue.png'})`,
    `  register_outcome({type: 'url', label: 'Staging Deploy', url: 'https://staging.example.com'})`,
    `  register_outcome({type: 'text', label: 'Summary', text: 'Revenue increased 23%...'})`,
    ``,
    `Auto-tracked tools (no need to register_outcome for these):`,
    `  pdf_create, excel_write, docx_create, audio_speak, image_generate,`,
    `  browser_screenshot, http_download, audio_transcribe, image_analyze`,
    ``,
    `RULES:`,
    `  - Prefer dedicated tools (pdf_create, excel_write, docx_create) when they fit your needs`,
    `  - If you MUST use bash to generate files (e.g. complex PDF via Python), ALWAYS call`,
    `    register_outcome afterward so the orchestrator can track and notify the result`,
    `  - For browser screenshots: navigate to the page first, then use browser_screenshot`,
    `  - The "write" tool auto-tracks outcomes for known binary extensions (pdf, xlsx, images, etc.)`,
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
  // Extended tool categories are enabled via agent config flags or by naming them in allowedTools
  const hasExtended = agentConfig.enableBrowser || agentConfig.enableHttp || agentConfig.enableGit ||
    agentConfig.enableMultifile || agentConfig.enableDeps || agentConfig.enableExcel ||
    agentConfig.enablePdf || agentConfig.enableDocx || agentConfig.enableEmail ||
    agentConfig.enableAudio || agentConfig.enableImage;

  // Derive browser profile / state directory
  const polpoDir = ctx?.polpoDir ?? join(cwd, ".polpo");
  const browserProfileDir = agentConfig.browserEngine === "playwright"
    ? join(polpoDir, "browser-profiles", agentConfig.browserProfile || agentConfig.name)
    : undefined;
  // For agent-browser: persistent state directory (same path convention as Playwright profiles)
  const browserStateDir = agentConfig.browserEngine !== "playwright" && agentConfig.enableBrowser
    ? join(polpoDir, "browser-profiles", agentConfig.browserProfile || agentConfig.name)
    : undefined;

  // Start with core coding tools (sync); extended tools loaded async in the run phase
  const codingTools = createCodingTools(cwd, agentConfig.allowedTools, agentConfig.allowedPaths);

  // MCP client manager — initialized later (async) if mcpServers are configured
  let mcpManager: McpClientManager | null = null;
  const hasMcp = agentConfig.mcpServers && Object.keys(agentConfig.mcpServers).length > 0;

  // Resolve reasoning level: agent config > global settings (via SpawnContext) > "off"
  const thinkingLevel = agentConfig.reasoning ?? ctx?.reasoning ?? "off";

  // Create the pi-agent-core Agent (starts with coding tools only; MCP tools added before prompt)
  const agent = new Agent({
    getApiKey: (provider: string) => resolveApiKeyAsync(provider),
    initialState: {
      systemPrompt: buildSystemPrompt(agentConfig, cwd, ctx?.polpoDir),
      model,
      thinkingLevel,
      tools: codingTools,
      messages: [],
      isStreaming: false,
      streamMessage: null,
      pendingToolCalls: new Set(),
    },
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

        // Auto-collect outcomes from tools that produce artifacts
        if (!event.isError && details) {
          const contentText = event.result?.content?.map((c: any) => c.text ?? "").join("") ?? "";
          const outcome = collectOutcome(event.toolName, details, contentText);
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
      // Resolve agent vault credentials from encrypted store
      const vaultEntries = ctx?.vaultStore?.getAllForAgent(agentConfig.name);
      const vault = resolveAgentVault(vaultEntries);

      // Resolve extended tools (async — Playwright import) and MCP servers before prompting
      let allTools = codingTools;
      if (hasExtended) {
        allTools = await createAllTools({
          cwd,
          allowedTools: agentConfig.allowedTools,
          allowedPaths: agentConfig.allowedPaths,
          browserSession: agentConfig.name,
          browserEngine: agentConfig.browserEngine,
          browserProfileDir,
          browserStateDir,
          enableBrowser: agentConfig.enableBrowser,
          enableHttp: agentConfig.enableHttp,
          enableGit: agentConfig.enableGit,
          enableMultifile: agentConfig.enableMultifile,
          enableDeps: agentConfig.enableDeps,
          enableExcel: agentConfig.enableExcel,
          enablePdf: agentConfig.enablePdf,
          enableDocx: agentConfig.enableDocx,
          enableEmail: agentConfig.enableEmail,
          enableAudio: agentConfig.enableAudio,
          enableImage: agentConfig.enableImage,
          vault,
          emailAllowedDomains: agentConfig.emailAllowedDomains ?? ctx?.emailAllowedDomains,
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
      // Close Playwright browser context (preserves profile data on disk)
      if (browserProfileDir) {
        const { cleanupPlaywrightContext } = await import("../tools/playwright-browser-tools.js");
        await cleanupPlaywrightContext(browserProfileDir).catch(() => {});
      }
      // Save agent-browser state and close session
      if (browserStateDir) {
        const { cleanupAgentBrowserSession } = await import("../tools/browser-tools.js");
        await cleanupAgentBrowserSession(agentConfig.name, browserStateDir).catch(() => {});
      }
    }
  })();

  return handle;
}

// ─── Outcome Auto-Collection ────────────────────────
//
// Maps tool names to outcome types. When a tool returns `details.path` or
// `details.bytes`, an outcome is automatically created.

/** Tools that produce file/media outcomes. Keyed by tool name. */
const OUTCOME_TOOLS: Record<string, { type: OutcomeType; labelPrefix: string }> = {
  audio_speak:      { type: "media",  labelPrefix: "Generated Audio" },
  image_generate:   { type: "media",  labelPrefix: "Generated Image" },
  excel_write:      { type: "file",   labelPrefix: "Excel File" },
  pdf_create:       { type: "file",   labelPrefix: "PDF Document" },
  pdf_merge:        { type: "file",   labelPrefix: "Merged PDF" },
  docx_create:      { type: "file",   labelPrefix: "Word Document" },
  http_download:    { type: "file",   labelPrefix: "Downloaded File" },
  audio_transcribe:    { type: "text",   labelPrefix: "Transcription" },
  image_analyze:       { type: "text",   labelPrefix: "Image Analysis" },
  browser_screenshot:  { type: "media",  labelPrefix: "Screenshot" },
};

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
 * Try to create a TaskOutcome from a tool execution result.
 * Returns undefined if the tool is not an outcome-producing tool.
 *
 * @param contentText - the concatenated text from the tool result's content blocks,
 *   used for text-type outcomes where the text is in content rather than details.
 */
function collectOutcome(toolName: string, details: Record<string, unknown>, contentText?: string): TaskOutcome | undefined {
  // register_outcome tool — agent explicitly declares an outcome with full control
  if (toolName === "register_outcome" && details.outcomeType && details.outcomeLabel) {
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

  let spec = OUTCOME_TOOLS[toolName];

  // For generic file-writing tools (write, bash), infer outcome from file extension
  if (!spec && (toolName === "write" || toolName === "bash")) {
    const path = details.path as string | undefined;
    if (path) {
      const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
      if ([".pdf"].includes(ext)) {
        spec = { type: "file", labelPrefix: "PDF Document" };
      } else if ([".xlsx", ".xls", ".csv"].includes(ext)) {
        spec = { type: "file", labelPrefix: "Spreadsheet" };
      } else if ([".docx"].includes(ext)) {
        spec = { type: "file", labelPrefix: "Word Document" };
      } else if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].includes(ext)) {
        spec = { type: "media", labelPrefix: "Image" };
      } else if ([".mp3", ".wav", ".ogg", ".flac", ".m4a"].includes(ext)) {
        spec = { type: "media", labelPrefix: "Audio" };
      } else if ([".mp4", ".webm", ".mov"].includes(ext)) {
        spec = { type: "media", labelPrefix: "Video" };
      } else if ([".html", ".htm"].includes(ext)) {
        spec = { type: "file", labelPrefix: "HTML Page" };
      } else if ([".zip", ".tar", ".gz"].includes(ext)) {
        spec = { type: "file", labelPrefix: "Archive" };
      }
    }
  }

  if (!spec) return undefined;

  const path = details.path as string | undefined;
  const bytes = details.bytes as number | undefined;
  // For text outcomes, prefer details.text, fall back to contentText
  const text = (details.text as string | undefined) ?? contentText;

  // For file/media outcomes, we need at least a path
  if ((spec.type === "file" || spec.type === "media") && !path) return undefined;
  // For text outcomes, we need text
  if (spec.type === "text" && !text) return undefined;

  const outcome: TaskOutcome = {
    id: nanoid(),
    type: spec.type,
    label: path ? `${spec.labelPrefix}: ${path.split("/").pop()}` : spec.labelPrefix,
    producedBy: toolName,
    producedAt: new Date().toISOString(),
  };

  if (path) {
    outcome.path = path;
    outcome.mimeType = guessMime(path);
    if (bytes) outcome.size = bytes;
  }

  if (text) {
    outcome.text = text;
  }

  return outcome;
}
