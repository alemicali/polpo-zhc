/**
 * Polpo's native agentic engine.
 * Uses @mariozechner/pi-agent-core Agent class for the agentic loop,
 * with pi-ai for multi-provider LLM abstraction.
 * Works with any LLM provider (Anthropic, OpenAI, Google, Groq, etc.)
 *
 * This is NOT an adapter — it's Polpo's built-in engine.
 * External tools (Claude CLI, OpenCode, Aider) use adapters (claude-sdk, generic).
 */

import type { AgentConfig, Task, TaskResult } from "../core/types.js";
import type { AgentAdapter, AgentHandle } from "../core/adapter.js";
import { createActivity, registerAdapter } from "./registry.js";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { resolveModel } from "../llm/pi-client.js";
import { createCodingTools } from "../tools/coding-tools.js";

/**
 * Build the system prompt for the agent.
 */
function buildSystemPrompt(agent: AgentConfig): string {
  const parts = [
    "You are a coding agent managed by Polpo, an AI agent orchestrator.",
    "Complete your assigned task autonomously. Make reasonable decisions and proceed without asking questions.",
  ];
  if (agent.systemPrompt) parts.push("", agent.systemPrompt);
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
    `- If you start a server, dev watcher, or any long-running process, run it DETACHED (background)`,
    `  and exit immediately. Do NOT wait for it, tail its logs, or keep your session alive.`,
    `- Example: use \`nohup cmd &\` or spawn detached. Never \`npm start\` in foreground.`,
    `- Your session has a timeout. If you hang, you will be killed and the task will fail.`,
  );
  return parts.join("\n");
}

class NativeAdapter implements AgentAdapter {
  readonly name = "native";

  spawn(agentConfig: AgentConfig, task: Task, cwd: string): AgentHandle {
    const activity = createActivity();
    const start = Date.now();
    let alive = true;

    // Resolve model
    const model = resolveModel(agentConfig.model);

    // Create tools scoped to working directory
    const tools = createCodingTools(cwd, agentConfig.allowedTools);

    // Create the pi-agent-core Agent
    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(agentConfig),
        model,
        thinkingLevel: "off",
        tools,
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
      }
    })();

    return handle;
  }
}

// Register the native engine
registerAdapter("native", () => new NativeAdapter());

export { NativeAdapter };
