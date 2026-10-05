export interface ContextModelLimits {
  contextWindow?: number;
  maxTokens?: number;
}

export interface ContextBudget {
  hardLimit: number;
  softLimit: number;
  targetTokens: number;
  keepRecentTokens: number;
}

export interface ContextMessageLike {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ContextEstimateInput {
  systemPrompt?: string;
  messages: ContextMessageLike[];
  tools?: unknown[];
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const CHARS_PER_TOKEN = 3;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function compactText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : safeStringify(value);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  const edge = Math.max(120, Math.floor((limit - 40) / 2));
  return `${normalized.slice(0, edge)} ... [truncated] ... ${normalized.slice(-edge)}`;
}

export function estimateMessageTokens(message: ContextMessageLike): number {
  return Math.ceil(safeStringify(message).length / CHARS_PER_TOKEN);
}

export function estimateContextTokens(input: ContextEstimateInput): number {
  let chars = input.systemPrompt?.length ?? 0;
  for (const message of input.messages) chars += safeStringify(message).length;
  if (input.tools?.length) {
    for (const tool of input.tools) {
      if (tool && typeof tool === "object") {
        const { execute: _execute, ...definition } = tool as Record<string, unknown>;
        chars += safeStringify(definition).length;
      } else {
        chars += safeStringify(tool).length;
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function contextBudgetForModel(model: ContextModelLimits): ContextBudget {
  const hardLimit = Math.max(16_384, model.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
  const configuredOutput = Math.max(0, model.maxTokens ?? 0);
  const outputReserve = Math.min(
    Math.max(16_384, configuredOutput),
    Math.floor(hardLimit * 0.25),
  );
  const softLimit = Math.min(
    hardLimit - outputReserve,
    Math.floor(hardLimit * 0.8),
  );
  return {
    hardLimit,
    softLimit,
    targetTokens: Math.floor(hardLimit * 0.5),
    keepRecentTokens: Math.min(100_000, Math.floor(hardLimit * 0.2)),
  };
}

/**
 * Select the first message retained after compaction. Tool results are kept
 * with the assistant message that produced their tool call.
 */
export function selectCompactionCut(messages: ContextMessageLike[], keepRecentTokens: number): number {
  if (messages.length < 2) return 0;
  let tokens = 0;
  let cut = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    tokens += estimateMessageTokens(messages[index]);
    cut = index;
    if (tokens >= keepRecentTokens) break;
  }

  while (cut > 0 && messages[cut]?.role === "toolResult") cut -= 1;
  return Math.min(Math.max(1, cut), messages.length - 1);
}

export function compactContextMessages(
  messages: ContextMessageLike[],
  cutIndex: number,
  summary: string,
): ContextMessageLike[] {
  if (cutIndex <= 0 || cutIndex >= messages.length) return [...messages];
  return [
    {
      role: "user",
      content: `[Context checkpoint: earlier conversation compacted]\n\n${summary.trim()}\n\n[End context checkpoint]`,
      timestamp: Date.now(),
    },
    ...messages.slice(cutIndex),
  ];
}

/**
 * Build a bounded, provider-independent checkpoint. It deliberately retains
 * both ends of large tool results because errors and final summaries commonly
 * live at the end of command output.
 */
export function summarizeContextMessages(
  messages: ContextMessageLike[],
  maxChars = 24_000,
): string {
  if (messages.length === 0) return "No earlier messages.";
  const perMessage = Math.max(120, Math.min(2_000, Math.floor(maxChars / messages.length) - 80));
  const lines: string[] = [];
  let used = 0;

  for (const message of messages) {
    const tool = typeof message.toolName === "string" ? ` (${message.toolName})` : "";
    const line = `- ${message.role}${tool}: ${compactText(message.content, perMessage)}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  const omitted = messages.length - lines.length;
  if (omitted > 0) lines.push(`- ${omitted} additional earlier messages omitted from this checkpoint.`);
  return lines.join("\n");
}
