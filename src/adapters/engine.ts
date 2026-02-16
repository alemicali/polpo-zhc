/**
 * Polpo Engine — the built-in agentic runtime.
 *
 * Uses @mariozechner/pi-agent-core Agent class for the agentic loop,
 * with pi-ai for multi-provider LLM abstraction.
 * Works with any LLM provider (Anthropic, OpenAI, Google, Groq, etc.)
 *
 * This is Polpo's default execution engine. When no adapter is specified
 * on an agent, this engine is used directly (not through the adapter registry).
 */

import type { AgentConfig, Task, TaskResult, TaskOutcome, OutcomeType } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
import { createActivity } from "./registry.js";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { resolveModel, resolveApiKey } from "../llm/pi-client.js";
import { createCodingTools, createAllTools } from "../tools/coding-tools.js";
import { loadAgentSkills, buildSkillPrompt } from "../llm/skills.js";
import { McpClientManager } from "../mcp/client.js";
import type { McpServerConfig } from "../mcp/types.js";
import { nanoid } from "nanoid";

/**
 * Build the system prompt for the agent, including loaded skills.
 */
function buildSystemPrompt(agent: AgentConfig, cwd: string, polpoDir?: string): string {
  const parts = [
    "You are a coding agent managed by Polpo, an AI agent orchestrator.",
    "Complete your assigned task autonomously. Make reasonable decisions and proceed without asking questions.",
  ];
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

  // Resolve model
  const model = resolveModel(agentConfig.model);

  // Create all tools scoped to working directory with path sandboxing
  // Extended tool categories are enabled via agent config flags or by naming them in allowedTools
  const hasExtended = agentConfig.enableBrowser || agentConfig.enableHttp || agentConfig.enableGit ||
    agentConfig.enableMultifile || agentConfig.enableDeps || agentConfig.enableExcel ||
    agentConfig.enablePdf || agentConfig.enableDocx || agentConfig.enableEmail ||
    agentConfig.enableAudio || agentConfig.enableImage;
  const codingTools = hasExtended
    ? createAllTools({
        cwd,
        allowedTools: agentConfig.allowedTools,
        allowedPaths: agentConfig.allowedPaths,
        browserSession: agentConfig.name,
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
      })
    : createCodingTools(cwd, agentConfig.allowedTools, agentConfig.allowedPaths);

  // MCP client manager — initialized later (async) if mcpServers are configured
  let mcpManager: McpClientManager | null = null;
  const hasMcp = agentConfig.mcpServers && Object.keys(agentConfig.mcpServers).length > 0;

  // Create the pi-agent-core Agent (starts with coding tools only; MCP tools added before prompt)
  const agent = new Agent({
    getApiKey: (provider: string) => resolveApiKey(provider),
    initialState: {
      systemPrompt: buildSystemPrompt(agentConfig, cwd, ctx?.polpoDir),
      model,
      thinkingLevel: "off",
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
      // Connect to MCP servers if configured (async — must happen before prompt)
      if (hasMcp) {
        mcpManager = new McpClientManager(cwd);
        const log = (msg: string) => handle.onTranscript?.({ type: "assistant", text: msg });
        await mcpManager.connectAll(
          agentConfig.mcpServers as Record<string, McpServerConfig>,
          log,
        );
        const mcpTools = mcpManager.getTools();
        if (mcpTools.length > 0) {
          // Merge MCP tools with coding tools and update the agent
          agent.setTools([...codingTools, ...mcpTools]);
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
  const spec = OUTCOME_TOOLS[toolName];
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
