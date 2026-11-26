/**
 * The coding chat card (an MCP App shown by polpo_coding_chat_show): a Claude Code / Codex session's
 * transcript, compact — the person's messages, the program's text, its tool calls as one line each
 * (edits with their +/− lines), approvals waiting (approve / deny from the card), status, model and
 * tokens. Built from the REST shape; the widget (widgets/coding-card) draws it, the text is for
 * clients without MCP Apps (and is the transcript polpo_coding_chat_show returns to the model).
 */
export interface CodingCardKey { createdAt: number; seq: number }
type Appearance = { light?: Record<string, string>; dark?: Record<string, string> };

export interface CodingCardTool { name: string; summary: string; state: string; added?: number; removed?: number }
export interface CodingCardMessage {
  id: string;
  role: "user" | "assistant";
  ts: string;
  text?: string;
  steer?: boolean;
  tools?: CodingCardTool[];
  streaming?: boolean;
  error?: string;
}
export interface CodingCardApproval { id: string; summary: string; reason: string; category: string; state: string }
export interface CodingCardSession {
  id: string; title: string; kind: "claude" | "codex"; status: string; cwd: string; branch?: string; model?: string; owner?: string;
  turns: number; totalTokens: number; costUsd: number; lastError?: string; errorKind?: string;
  /** Opened from a terminal session: what it continues. */
  note?: string;
}
export interface CodingCard {
  kind: "coding-chat";
  key: CodingCardKey;
  generatedAt: string;
  session: CodingCardSession;
  messages: CodingCardMessage[];
  /** Older messages left out. */
  earlier: number;
  approvals: CodingCardApproval[];
  link?: string;
  appearance?: Appearance;
}

/** The REST shapes the card reads (GET /coding/chats/{id}). */
interface ToolShape { id: string; name: string; input?: Record<string, unknown>; diff?: string; state: string }
type SegmentShape = { type: "text"; text: string } | { type: "reasoning"; text: string } | { type: "tool"; tool: ToolShape } | { type: "approval"; approvalId: string };
export interface CodingSessionShape {
  id: string; title: string; kind: "claude" | "codex"; status: string; cwd: string; branch?: string; model?: string; owner?: string;
  turns: number; usage: { totalTokens: number }; costUsd: number; lastError?: string; errorKind?: string;
  continuedFrom?: { note: string; status: string };
  messages: Array<{ id: string; role: "user" | "assistant"; ts: string; text?: string; kind?: string; segments?: SegmentShape[]; streaming?: boolean; error?: string }>;
  approvals: Array<{ id: string; summary: string; reason: string; category: string; state: string }>;
}

const VERBS: Record<string, string> = {
  edit: "Edited", multiedit: "Edited", write: "Wrote", notebookedit: "Edited", apply_patch: "Changed", read: "Read", glob: "Found files", grep: "Searched",
  ls: "Listed", bash: "Ran", shell: "Ran", webfetch: "Fetched", websearch: "Searched the web", web_search: "Searched the web", todowrite: "Updated the plan", task: "Delegated",
};

function oneLine(s: string, n = 120): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** A tool call in one line: "Edited src/a.ts", "Ran pnpm test". */
export function toolSummary(t: ToolShape): CodingCardTool {
  const i = t.input ?? {};
  const verb = VERBS[t.name.toLowerCase()] ?? t.name;
  const target = [i.command, i.file_path, i.path, i.pattern, i.url, i.query]
    .map((v) => (Array.isArray(v) ? v.join(" ") : v)).find((v): v is string => typeof v === "string" && !!v.trim());
  const lines = (t.diff ?? "").split("\n");
  const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
  return {
    name: t.name, state: t.state, summary: target ? `${verb} ${oneLine(target, 100)}` : verb,
    ...(t.diff ? { added, removed } : {}),
  };
}

export function buildCodingCard(o: { session: CodingSessionShape; key: CodingCardKey; link?: string; limit?: number }): CodingCard {
  const s = o.session;
  const limit = o.limit ?? 12;
  const recent = s.messages.slice(-limit);
  return {
    kind: "coding-chat",
    key: o.key,
    generatedAt: new Date().toISOString(),
    session: {
      id: s.id, title: s.title, kind: s.kind, status: s.status, cwd: s.cwd, turns: s.turns, totalTokens: s.usage?.totalTokens ?? 0, costUsd: s.costUsd ?? 0,
      ...(s.branch ? { branch: s.branch } : {}), ...(s.model ? { model: s.model } : {}), ...(s.owner ? { owner: s.owner } : {}),
      ...(s.lastError ? { lastError: s.lastError } : {}), ...(s.errorKind ? { errorKind: s.errorKind } : {}),
      ...(s.continuedFrom?.note ? { note: s.continuedFrom.note } : {}),
    },
    messages: recent.map((m) => {
      const segs = m.segments ?? [];
      const text = m.role === "user" ? m.text : segs.flatMap((x) => (x.type === "text" ? [x.text] : [])).join("\n\n");
      const tools = segs.flatMap((x) => (x.type === "tool" ? [toolSummary(x.tool)] : []));
      return {
        id: m.id, role: m.role, ts: m.ts,
        ...(text?.trim() ? { text: text.length > 1500 ? `${text.slice(0, 1500)}…` : text } : {}),
        ...(m.kind === "steer" ? { steer: true } : {}),
        ...(tools.length ? { tools } : {}),
        ...(m.streaming ? { streaming: true } : {}),
        ...(m.error ? { error: m.error } : {}),
      };
    }),
    earlier: Math.max(0, s.messages.length - recent.length),
    approvals: s.approvals.filter((a) => a.state === "pending").map((a) => ({ id: a.id, summary: a.summary, reason: a.reason, category: a.category, state: a.state })),
    ...(o.link ? { link: o.link } : {}),
  };
}

/** The card as text (clients without MCP Apps; the transcript the model reads). */
export function codingCardText(card: CodingCard): string {
  const s = card.session;
  const head = `${s.title} (${s.kind === "claude" ? "Claude Code" : "Codex"}${s.model ? `, ${s.model}` : ""}) · ${s.status} · ${s.branch ? `${s.branch} · ` : ""}${s.cwd} · ${s.turns} turn(s), ${s.totalTokens} tokens · id ${s.id}`;
  const lines = [head];
  if (s.note) lines.push(s.note);
  if (s.lastError) lines.push(`Last error: ${s.lastError}`);
  if (card.earlier) lines.push(`(${card.earlier} earlier message(s) not shown)`);
  for (const m of card.messages) {
    if (m.role === "user") lines.push(`\n${m.steer ? "Person (while it worked)" : "Person"}: ${m.text ?? ""}`);
    else {
      const parts = [
        ...(m.tools ?? []).map((t) => `  - ${t.summary}${t.added !== undefined ? ` (+${t.added} −${t.removed})` : ""}${t.state === "error" ? " [failed]" : t.state === "running" ? " [running]" : t.state === "interrupted" ? " [interrupted]" : ""}`),
        ...(m.text ? [m.text] : []),
      ];
      lines.push(`\n${s.kind === "claude" ? "Claude Code" : "Codex"}${m.streaming ? " (working…)" : ""}:${parts.length ? `\n${parts.join("\n")}` : ""}${m.error ? `\n  ⚠ ${m.error}` : ""}`);
    }
  }
  for (const a of card.approvals) lines.push(`\nWAITING FOR APPROVAL ${a.id}: ${a.summary} — ${a.reason}`);
  return lines.join("\n");
}
