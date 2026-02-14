import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfig, AgentActivity, Task, TaskResult } from "../core/types.js";
import type { AgentAdapter, AgentHandle } from "../core/adapter.js";
import { createActivity, registerAdapter } from "./registry.js";

/** Truncate a string for logging. Works on any value — stringifies non-strings. */
function truncateHook(value: unknown, max: number): string | undefined {
  if (value == null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

/**
 * Claude Agent SDK adapter.
 * Uses @anthropic-ai/claude-agent-sdk to run Claude Code programmatically.
 * Full streaming, hooks, activity tracking — no process spawning or stdout parsing.
 */
class ClaudeSDKAdapter implements AgentAdapter {
  readonly name = "claude-sdk";

  spawn(agent: AgentConfig, task: Task, cwd: string): AgentHandle {
    const activity = createActivity();
    const abortController = new AbortController();
    let alive = true;

    const prompt = buildPrompt(task);

    // Build allowedTools — ensure "Skill" is included when agent has skills
    let allowedTools = agent.allowedTools;
    if (agent.skills?.length) {
      const tools = new Set(allowedTools ?? []);
      tools.add("Skill");
      allowedTools = [...tools];
    }

    const options: Options = {
      cwd,
      abortController,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: true,
      model: agent.model,
      maxTurns: agent.maxTurns ?? 150,
      allowedTools,
      disallowedTools: ["Task", "AskUserQuestion"],
      hooks: {
        PostToolUse: [{
          hooks: [async (rawInput) => {
            const input = rawInput as any;
            trackToolUse(input, activity);
            // Capture sessionId from hook input
            if (input?.session_id && !activity.sessionId) {
              activity.sessionId = input.session_id;
            }
            // Persist tool result to transcript
            if (handle.onTranscript && input?.tool_name) {
              handle.onTranscript({
                type: "post_tool_use",
                tool: input.tool_name,
                file: input.tool_input?.file_path ?? input.tool_input?.path,
                output: truncateHook(input.tool_output, 2000),
              });
            }
            return {};
          }],
        }],
      },
    };

    // Build system prompt: user-defined + skill directives
    const systemParts: string[] = [];
    if (agent.systemPrompt) systemParts.push(agent.systemPrompt);
    if (agent.skills?.length) {
      systemParts.push(
        `\nYou have the following skills assigned to you. Use ONLY these skills (via the Skill tool) when applicable — do not use other installed skills:\n` +
        agent.skills.map(s => `- ${s}`).join("\n")
      );
    }
    if (systemParts.length > 0) {
      (options as any).systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: systemParts.join("\n\n"),
      };
    }

    // Add MCP servers if configured
    if (agent.mcpServers) {
      options.mcpServers = agent.mcpServers as Options["mcpServers"];
    }

    const handle: AgentHandle = {
      agentName: agent.name,
      taskId: task.id,
      startedAt: new Date().toISOString(),
      pid: 0,
      activity,
      done: null as any, // set below
      isAlive: () => alive,
      kill: () => {
        abortController.abort();
        alive = false;
      },
    };

    handle.done = runQuery(prompt, options, activity, handle, () => {
      alive = false;
      // Copy sessionId to handle for persistence
      if (activity.sessionId) handle.sessionId = activity.sessionId;
    });

    return handle;
  }
}

/** Build the prompt string sent to the agent from task data. */
export function buildPrompt(task: Task): string {
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
    `- If you start a server, dev watcher, or any long-running process, run it DETACHED (background)`,
    `  and exit immediately. Do NOT wait for it, tail its logs, or keep your session alive.`,
    `- Example: use \`nohup cmd &\` or spawn detached. Never \`npm start\` in foreground.`,
    `- Your session has a timeout. If you hang, you will be killed and the task will fail.`,
  );
  return parts.join("\n");
}

/**
 * Run the Claude Agent SDK query and collect the result.
 * Streams all messages, tracks activity, persists transcript, and produces a TaskResult.
 */
async function runQuery(
  prompt: string,
  options: Options,
  activity: AgentActivity,
  handle: AgentHandle,
  onFinish: () => void,
): Promise<TaskResult> {
  const start = Date.now();
  let resultText = "";
  let errorOccurred = false;
  let errorMessage = "";

  try {
    const q = query({ prompt, options });

    for await (const message of q) {
      activity.lastUpdate = new Date().toISOString();
      processMessage(message, activity);

      // Persist transcript entry
      emitTranscript(handle, message);

      // Capture final result
      if (message.type === "result") {
        const result = message as unknown as { subtype: string; result?: string; errors?: string[] };
        if (result.subtype === "success" && result.result) {
          resultText = result.result;
        } else if (result.subtype !== "success") {
          errorOccurred = true;
          errorMessage = result.errors?.join("; ") ?? result.subtype;
        }
      }
    }
  } catch (err: unknown) {
    errorOccurred = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    onFinish();
  }

  return {
    exitCode: errorOccurred ? 1 : 0,
    stdout: resultText,
    stderr: errorMessage,
    duration: Date.now() - start,
  };
}

/**
 * Emit a transcript entry for persistence.
 * Extracts meaningful data from SDK messages — text, tool_use, tool_result.
 */
function emitTranscript(handle: AgentHandle, message: SDKMessage): void {
  if (!handle.onTranscript) return;

  if (message.type === "assistant" && message.message) {
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          handle.onTranscript({ type: "assistant", text: block.text });
        }
        if (block.type === "tool_use") {
          handle.onTranscript({
            type: "tool_use",
            tool: block.name,
            toolId: block.id,
            input: block.input,
          });
        }
      }
    }
  }

  // tool_result comes through as a raw message type not in the SDK union
  const msgType = (message as any).type;
  if (msgType === "tool_result") {
    const msg = message as any;
    handle.onTranscript({
      type: "tool_result",
      toolId: msg.tool_use_id,
      content: truncate(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content), 2000),
    });
  }

  if (message.type === "result") {
    const result = message as unknown as { subtype: string; result?: string; errors?: string[] };
    handle.onTranscript({
      type: "result",
      subtype: result.subtype,
      result: truncate(result.result, 1000),
      errors: result.errors,
    });
  }
}

function truncate(s: string | undefined, max: number): string | undefined {
  if (!s) return s;
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}

/**
 * Process an SDK message and update activity tracking.
 */
function processMessage(message: SDKMessage, activity: AgentActivity): void {
  // Capture sessionId from any message that has it
  const msg = message as any;
  if (msg.session_id && !activity.sessionId) {
    activity.sessionId = msg.session_id;
  }
  if (msg.sessionId && !activity.sessionId) {
    activity.sessionId = msg.sessionId;
  }

  // Assistant messages — extract text summary
  if (message.type === "assistant" && message.message) {
    const content = message.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text") {
          activity.summary = block.text.slice(0, 200);
        }
        if (block.type === "tool_use") {
          activity.toolCalls++;
          activity.lastTool = block.name;
        }
      }
    }
  }

  // Tool progress
  if (message.type === "tool_progress") {
    activity.lastTool = message.tool_name;
  }
}

/**
 * PostToolUse hook callback — tracks file operations.
 */
export function trackToolUse(input: any, activity: AgentActivity): void {
  const toolName = input?.tool_name;
  const toolInput = input?.tool_input as Record<string, unknown> | undefined;
  if (!toolName || !toolInput) return;

  const filePath = (toolInput.file_path ?? toolInput.path ?? toolInput.filePath) as string | undefined;
  if (!filePath) return;

  if (toolName === "Write") {
    if (!activity.filesCreated.includes(filePath)) activity.filesCreated.push(filePath);
  } else if (toolName === "Edit") {
    if (!activity.filesEdited.includes(filePath)) activity.filesEdited.push(filePath);
  }

  activity.lastFile = filePath;
}

// Register this adapter
registerAdapter("claude-sdk", () => new ClaudeSDKAdapter());

export { ClaudeSDKAdapter };
