import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionMessage {
  type: "user" | "assistant" | "system" | string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string; input?: any }>;
  };
}

export interface SessionSummary {
  sessionId: string;
  transcriptPath: string;
  messageCount: number;
  toolCalls: string[];
  filesCreated: string[];
  filesEdited: string[];
  lastMessage: string;
  todos: string[];
  errors: string[];
}

/**
 * Find the JSONL transcript file for a given SDK session ID.
 * Sessions are stored in ~/.claude/projects/<encoded-cwd>/<sessionId>/<sessionId>.jsonl
 */
export function findTranscriptPath(sessionId: string, cwd: string): string | null {
  // Encode CWD to project path format: /home/user/foo → -home-user-foo
  const encoded = cwd.replace(/\//g, "-").replace(/^-/, "-");
  const claudeDir = join(homedir(), ".claude", "projects");

  // Try encoded path
  const candidates = [
    join(claudeDir, encoded, sessionId, `${sessionId}.jsonl`),
  ];

  // Also try listing project dirs in case encoding differs
  if (existsSync(claudeDir)) {
    try {
      const dirs = readdirSync(claudeDir);
      for (const d of dirs) {
        const candidate = join(claudeDir, d, sessionId, `${sessionId}.jsonl`);
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
    } catch { /* ignore */ }
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Read and summarize a session transcript.
 * Extracts tool calls, files touched, TODOs, errors, and last message.
 */
export function readSessionSummary(sessionId: string, cwd: string): SessionSummary | null {
  const transcriptPath = findTranscriptPath(sessionId, cwd);
  if (!transcriptPath) return null;

  const toolCalls: string[] = [];
  const filesCreated: string[] = [];
  const filesEdited: string[] = [];
  const todos: string[] = [];
  const errors: string[] = [];
  let lastMessage = "";
  let messageCount = 0;

  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());

    for (const line of lines) {
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      messageCount++;

      if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) {
              lastMessage = block.text.slice(0, 300);

              // Extract TODO items
              const todoMatches = block.text.match(/(?:TODO|FIXME|HACK|XXX)[:：\s].*$/gmi);
              if (todoMatches) {
                for (const t of todoMatches) todos.push(t.trim());
              }
            }
            if (block.type === "tool_use") {
              const toolName = block.name;
              const input = block.input as Record<string, any> | undefined;
              toolCalls.push(toolName);

              const filePath = input?.file_path ?? input?.path ?? input?.filePath;
              if (filePath && typeof filePath === "string") {
                if (toolName === "Write") {
                  if (!filesCreated.includes(filePath)) filesCreated.push(filePath);
                } else if (toolName === "Edit") {
                  if (!filesEdited.includes(filePath)) filesEdited.push(filePath);
                }
              }
            }
          }
        }
      }

      // Capture errors from result messages
      if (msg.type === "result") {
        const result = msg as any;
        if (result.subtype !== "success" && result.errors) {
          for (const e of result.errors) errors.push(String(e).slice(0, 200));
        }
      }
    }
  } catch { return null; }

  return {
    sessionId,
    transcriptPath,
    messageCount,
    toolCalls,
    filesCreated,
    filesEdited,
    lastMessage,
    todos,
    errors,
  };
}

/**
 * Get the last N assistant messages from a session transcript.
 */
export function getRecentMessages(sessionId: string, cwd: string, limit = 5): string[] {
  const transcriptPath = findTranscriptPath(sessionId, cwd);
  if (!transcriptPath) return [];

  const messages: string[] = [];

  try {
    const raw = readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());

    for (const line of lines) {
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.type === "assistant" && msg.message?.content) {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text?.trim()) {
              messages.push(block.text.slice(0, 500));
            }
          }
        }
      }
    }
  } catch { return []; }

  return messages.slice(-limit);
}
