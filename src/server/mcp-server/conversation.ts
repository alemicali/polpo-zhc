/**
 * Conversations with Polpo or an agent over MCP: polpo_ask, polpo_agent_chat and polpo_answer.
 *
 * A turn can stop to ask the person something (ask_user) or to show a preview that needs a decision
 * (a mission plan, a WhatsApp message or an email to send, a secret to save). The web chat shows a
 * card; here the turn returns `status: "needs_input"` with the pending item, and polpo_answer gives
 * the answer the way the web chat does (same REST calls, then the conversation goes on).
 *
 * The pending item is read back from the session's last message (its interrupted tool call), so it
 * survives between stateless requests and a new message simply moves the conversation on.
 */
import { z } from "zod";
import {
  apiGet, apiSend, enc, fail, ok, progress, short,
  type CallToolResult, type McpDeps, type Register, type ToolExtra,
} from "./kit.js";

/** Kinds of pending input, and what polpo_answer accepts for each. */
export const PENDING_ACTIONS = {
  questions: ["answer"],
  mission_preview: ["execute", "save_draft", "refine", "cancel"],
  whatsapp_preview: ["send", "refine", "cancel"],
  email_preview: ["send", "refine", "cancel"],
  vault_preview: ["cancel"],
} as const;
export type PendingKind = keyof typeof PENDING_ACTIONS;

export interface PendingQuestion {
  id: string;
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
  custom?: boolean;
}

export interface Pending {
  /** The interrupted tool call (pass it as pending_id to be sure you answer this one). */
  id?: string;
  kind: PendingKind;
  actions: readonly string[];
  questions?: PendingQuestion[];
  mission?: { name: string; prompt?: string; plan: unknown };
  whatsapp?: Record<string, unknown>;
  email?: Record<string, unknown>;
  /** A secret to save: its fields' names only, never their values. */
  vault?: { agent: string; service: string; type: string; label?: string; fields: string[] };
  /** Where the person finishes it in the dashboard, when MCP cannot (secrets). */
  dashboard_url?: string;
}

export interface TurnOutput extends Record<string, unknown> {
  status: "replied" | "needs_input";
  reply: string;
  session_id: string;
  agent?: string;
  pending?: Pending;
  /** Links and files the reply pointed to (in the web chat they open by themselves). */
  links?: Array<{ kind: string; target: string; label?: string }>;
  /** What polpo_answer did before the conversation went on (e.g. a mission created). */
  done?: Record<string, unknown>;
}

const pendingSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(Object.keys(PENDING_ACTIONS) as [PendingKind, ...PendingKind[]]),
  actions: z.array(z.string()),
  questions: z.array(z.object({
    id: z.string(), question: z.string(), header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    multiple: z.boolean().optional(), custom: z.boolean().optional(),
  })).optional(),
  mission: z.object({ name: z.string(), prompt: z.string().optional(), plan: z.unknown() }).optional(),
  whatsapp: z.record(z.string(), z.unknown()).optional(),
  email: z.record(z.string(), z.unknown()).optional(),
  vault: z.object({ agent: z.string(), service: z.string(), type: z.string(), label: z.string().optional(), fields: z.array(z.string()) }).optional(),
  dashboard_url: z.string().optional(),
});

export const turnOutputSchema = {
  status: z.enum(["replied", "needs_input"]).describe("needs_input: answer with polpo_answer before going on"),
  reply: z.string().describe("The text of the reply"),
  session_id: z.string().describe("Pass it to continue this conversation"),
  agent: z.string().optional(),
  pending: pendingSchema.optional().describe("What the turn waits for (questions or a preview), when status is needs_input"),
  links: z.array(z.object({ kind: z.string(), target: z.string(), label: z.string().optional() })).optional(),
  done: z.record(z.string(), z.unknown()).optional(),
};

const INTERACTIVE_KIND: Record<string, PendingKind> = {
  ask_user: "questions",
  create_mission: "mission_preview",
  whatsapp_send: "whatsapp_preview",
  whatsapp_send_file: "whatsapp_preview",
  email_send: "email_preview",
  set_vault_entry: "vault_preview",
};

function dashboard(deps: McpDeps, path: string): string | undefined {
  return deps.publicUrl ? `${deps.publicUrl.replace(/\/+$/, "")}${path}` : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** The pending item of an interactive tool call (from the completion's payload or the stored call). */
export function pendingFrom(deps: McpDeps, tool: string, args: Record<string, unknown>, id?: string): Pending | undefined {
  const kind = INTERACTIVE_KIND[tool];
  if (!kind) return undefined;
  const base = { ...(id ? { id } : {}), kind, actions: PENDING_ACTIONS[kind] };
  switch (kind) {
    case "questions": {
      const questions = (Array.isArray(args.questions) ? args.questions : []) as Array<Record<string, unknown>>;
      return {
        ...base,
        questions: questions.map((q, i) => ({
          id: str(q.id) ?? `q${i + 1}`,
          question: str(q.question) ?? str(q.header) ?? "",
          ...(str(q.header) ? { header: str(q.header) } : {}),
          options: (Array.isArray(q.options) ? q.options : []).map((o: unknown) => typeof o === "string"
            ? { label: o }
            : { label: str((o as Record<string, unknown>)?.label) ?? "", ...(str((o as Record<string, unknown>)?.description) ? { description: str((o as Record<string, unknown>).description) } : {}) }),
          ...(typeof q.multiple === "boolean" ? { multiple: q.multiple } : {}),
          ...(typeof q.custom === "boolean" ? { custom: q.custom } : {}),
        })),
      };
    }
    case "mission_preview": {
      let plan: unknown = args.data;
      if (typeof plan === "string") { try { plan = JSON.parse(plan); } catch { /* keep the text */ } }
      return { ...base, mission: { name: str(args.name) ?? "mission", ...(str(args.prompt) ? { prompt: str(args.prompt) } : {}), plan } };
    }
    case "whatsapp_preview": {
      const file = tool === "whatsapp_send_file";
      const fields = file ? ["to", "path", "caption", "mediaKind", "mimeType", "fileName", "viewOnce"] : ["to", "message"];
      return { ...base, whatsapp: { kind: file ? "file" : "text", ...Object.fromEntries(fields.filter((f) => args[f] !== undefined).map((f) => [f, args[f]])) } };
    }
    case "email_preview": {
      const fields = ["to", "subject", "body", "html", "cc", "bcc", "from", "reply_to", "attachments"];
      return { ...base, email: Object.fromEntries(fields.filter((f) => args[f] !== undefined).map((f) => [f, args[f]])) };
    }
    case "vault_preview": {
      const agent = str(args.agent) ?? "";
      const credentials = args.credentials && typeof args.credentials === "object" ? Object.keys(args.credentials as object) : [];
      const url = dashboard(deps, `/agents/${enc(agent)}`);
      return {
        ...base,
        vault: { agent, service: str(args.service) ?? "", type: str(args.type) ?? "custom", ...(str(args.label) ? { label: str(args.label) } : {}), fields: credentials },
        ...(url ? { dashboard_url: url } : {}),
      };
    }
  }
}

/** Rebuild the finish_reason payload of a completion choice as the tool call it came from. */
function interactiveCallOf(choice: Record<string, unknown>): { tool: string; args: Record<string, unknown> } | undefined {
  const reason = choice.finish_reason;
  const payload = (key: string) => (choice[key] ?? {}) as Record<string, unknown>;
  switch (reason) {
    case "ask_user": return { tool: "ask_user", args: payload("ask_user") };
    case "mission_preview": return { tool: "create_mission", args: payload("mission_preview") };
    case "vault_preview": return { tool: "set_vault_entry", args: payload("vault_preview") };
    case "email_preview": return { tool: "email_send", args: payload("email_preview") };
    case "whatsapp_preview": {
      const p = payload("whatsapp_preview");
      return { tool: p.kind === "file" ? "whatsapp_send_file" : "whatsapp_send", args: p };
    }
    default: return undefined;
  }
}

/** Links a reply pointed to (open_file, navigate_to, open_tab), and notes for what only the web chat shows. */
function linksOf(deps: McpDeps, choice: Record<string, unknown>): { links: TurnOutput["links"]; note?: string } {
  const p = (key: string) => (choice[key] ?? {}) as Record<string, unknown>;
  switch (choice.finish_reason) {
    case "open_file": return { links: [{ kind: "file", target: str(p("open_file").path) ?? "" }] };
    case "open_tab": return { links: [{ kind: "url", target: str(p("open_tab").url) ?? "", ...(str(p("open_tab").label) ? { label: str(p("open_tab").label) } : {}) }] };
    case "navigate_to": {
      const n = p("navigate_to");
      const target = str(n.url) ?? dashboard(deps, `/${[str(n.target) ?? "dashboard", str(n.id) ?? str(n.name)].filter(Boolean).map((s) => enc(s!)).join("/")}`) ?? str(n.target) ?? "";
      return { links: [{ kind: "dashboard", target }] };
    }
    case "widget_render": return { links: [], note: "(Polpo made an interactive view: it shows in the dashboard chat.)" };
    case "set_design": return { links: [], note: "(Polpo proposed a new look for the dashboard: apply it from the dashboard chat; it is not applied from here.)" };
    default: return { links: [] };
  }
}

/** The session's agent (undefined for Polpo), or an error message. */
async function sessionAgent(deps: McpDeps, sessionId: string): Promise<{ ok: true; agent?: string } | { ok: false; error: string }> {
  const r = await apiGet(deps, "/chat/sessions");
  if (!r.ok) return { ok: false, error: r.error };
  const sessions = ((r.data as { sessions?: Array<{ id: string; agent?: string | null }> })?.sessions ?? []);
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return { ok: false, error: `No conversation ${sessionId}` };
  return { ok: true, ...(s.agent ? { agent: s.agent } : {}) };
}

interface StoredMessage { id?: string; role: string; content: unknown; toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown>; state?: string }> }

async function sessionMessages(deps: McpDeps, sessionId: string): Promise<{ ok: true; messages: StoredMessage[] } | { ok: false; error: string; status: number }> {
  const r = await apiGet(deps, `/chat/sessions/${enc(sessionId)}/messages`);
  if (!r.ok) return r;
  const messages = (Array.isArray(r.data) ? r.data : (r.data as { messages?: unknown[] })?.messages ?? []) as StoredMessage[];
  return { ok: true, messages };
}

/** The pending item of a session: its last message is Polpo's, stopped at an interactive tool. */
export function pendingOfMessages(deps: McpDeps, messages: StoredMessage[]): Pending | undefined {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return undefined;
  const call = [...(last.toolCalls ?? [])].reverse().find((tc) => tc.state === "interrupted" && INTERACTIVE_KIND[tc.name]);
  return call ? pendingFrom(deps, call.name, call.arguments ?? {}, call.id) : undefined;
}

/** One chat turn with Polpo (no agent) or an agent; the conversation continues with sessionId. */
export async function chatTurn(deps: McpDeps, message: string, agent: string | undefined, sessionId: string | undefined, extra?: ToolExtra, done?: Record<string, unknown>): Promise<CallToolResult> {
  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (sessionId) {
    const r = await sessionMessages(deps, sessionId);
    if (!r.ok) return fail(r.status === 404
      ? `There is no conversation ${sessionId}. Omit session_id to start a new one.`
      : `Could not load conversation ${sessionId}: ${r.error}. Try again, or omit session_id to start a new one.`);
    for (const m of r.messages) {
      if ((m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()) history.push({ role: m.role, content: m.content });
    }
  }
  // the turn can take minutes (agents, browsing): tell clients that asked for progress it is still running
  let beats = 0;
  const heartbeat = extra?._meta?.progressToken !== undefined
    ? setInterval(() => { void progress(extra, ++beats, undefined, `${agent ?? "Polpo"} is still working…`); }, 5000)
    : undefined;
  let res;
  try {
    res = await deps.api("POST", "/v1/chat/completions", {
      stream: false,
      ...(agent ? { agent } : {}),
      messages: [...history, { role: "user", content: message }],
    }, { "x-session-id": sessionId ?? "new" });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  const body = res.body as { choices?: Array<Record<string, unknown>>; error?: { message?: string; code?: string } } | null;
  if (res.status === 409) return fail("This conversation is still answering an earlier message: wait a little and try again, or start a new one (omit session_id).");
  if (res.status === 404 && agent) return fail(`${body?.error?.message ?? `No agent "${agent}"`}. Use polpo_agents_list for the names.`);
  if (res.status >= 400) return fail(`The turn failed (HTTP ${res.status}): ${body?.error?.message ?? JSON.stringify(body)}. Try again, or rephrase.`);
  const choice = body?.choices?.[0] ?? {};
  const reply = str((choice.message as { content?: unknown } | undefined)?.content) ?? "";
  const session = res.headers.get("x-session-id") ?? sessionId ?? "";

  const out: TurnOutput = { status: "replied", reply, session_id: session, ...(agent ? { agent } : {}), ...(done ? { done } : {}) };
  const interactive = interactiveCallOf(choice);
  if (interactive) {
    // the stored call carries the id the answer refers to
    let id: string | undefined;
    if (session) {
      const stored = await sessionMessages(deps, session);
      if (stored.ok) id = pendingOfMessages(deps, stored.messages)?.id;
    }
    const pending = pendingFrom(deps, interactive.tool, interactive.args, id);
    if (pending) {
      out.status = "needs_input";
      out.pending = pending;
    }
  }
  const { links, note } = linksOf(deps, choice);
  if (links?.length) out.links = links;
  return ok(turnText(out, note), out);
}

/** The model's view of a turn: the reply, then what it waits for and how to answer. */
export function turnText(out: TurnOutput, note?: string): string {
  const parts: string[] = [];
  if (out.done) parts.push(`Done: ${Object.entries(out.done).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(", ")}.`);
  parts.push(out.reply.trim() || (out.pending ? "" : "(no text reply)"));
  if (note) parts.push(note);
  for (const l of out.links ?? []) parts.push(`→ ${l.kind}: ${l.target}${l.label ? ` (${l.label})` : ""}`);
  const p = out.pending;
  if (p) {
    const how = `Answer with polpo_answer (session_id ${out.session_id}${p.id ? `, pending_id ${p.id}` : ""}).`;
    if (p.kind === "questions") {
      const qs = (p.questions ?? []).map((q) => `- [${q.id}] ${q.question}${q.options.length ? `\n  options: ${q.options.map((o) => o.label).join(" | ")}${q.multiple ? " (several allowed)" : ""}` : ""}`).join("\n");
      parts.push(`${out.agent ?? "Polpo"} asks:\n${qs}\nAsk the person, then ${how} with answers: [{ question_id, selected?, text? }].`);
    } else if (p.kind === "mission_preview") {
      const tasks = ((p.mission?.plan as { tasks?: Array<{ title?: string; assignTo?: string }> })?.tasks ?? []);
      parts.push(`Mission to review: "${p.mission?.name}" (${tasks.length} tasks)\n${tasks.map((t, i) => `${i + 1}. ${t.title}${t.assignTo ? ` → ${t.assignTo}` : ""}`).join("\n")}\n`
        + `Show the plan to the person. ${how} action: execute (with confirm: true) | save_draft | refine (with feedback) | cancel.`);
    } else if (p.kind === "whatsapp_preview" || p.kind === "email_preview") {
      const m = (p.whatsapp ?? p.email)!;
      const summary = p.kind === "email_preview"
        ? `Email to ${JSON.stringify(m.to)}: "${short(m.subject, 80)}"\n${short(m.body, 600)}`
        : `WhatsApp to ${String(m.to)}: ${short(m.message ?? m.caption ?? m.path, 600)}`;
      parts.push(`Ready to send, waiting for the person's OK:\n${summary}\n${how} action: send (with confirm: true, only after the person agreed) | refine (with feedback) | cancel.`);
    } else if (p.kind === "vault_preview") {
      parts.push(`Polpo wants to save a secret (${p.vault?.service}, fields: ${p.vault?.fields.join(", ")}) for ${p.vault?.agent}. Secrets are never sent through MCP: `
        + `the person enters it in the dashboard${p.dashboard_url ? ` (${p.dashboard_url})` : ""}. ${how} action: cancel, to tell Polpo.`);
    }
  }
  parts.push(`[session_id: ${out.session_id} — pass it to continue this conversation]`);
  return parts.filter(Boolean).join("\n\n");
}

const answersSchema = z.array(z.object({
  question_id: z.string().min(1).describe("The question's id (pending.questions[].id)"),
  selected: z.array(z.string()).optional().describe("Labels of the chosen options"),
  text: z.string().optional().describe("A free-text answer (or a note with the choice)"),
}));

export function registerConversationTools(tool: Register, deps: McpDeps): void {
  tool("core", "polpo_ask", {
    title: "Ask Polpo",
    description: "Ask Polpo, the orchestrator, in natural language. Use it for open-ended requests that span several steps "
      + "(plan and run work, set up agents, investigate, make artifacts) or when no specific tool fits. "
      + "It returns Polpo's reply and a session_id: pass session_id to continue the same conversation. "
      + "When status is needs_input, Polpo stopped to ask the person something or to show a preview (a mission plan, a message to send): "
      + "show it to the person and reply with polpo_answer. A turn can take a while.",
    inputSchema: {
      message: z.string().min(1).describe("What to ask or tell Polpo, as the person would write it"),
      session_id: z.string().optional().describe("Continue an earlier conversation (from a previous result); omit to start a new one"),
    },
    outputSchema: turnOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ message, session_id }, extra) => chatTurn(deps, message, undefined, session_id, extra));

  tool("core", "polpo_agent_chat", {
    title: "Chat with an agent",
    description: "Send a message to one agent and get its reply; it works with its own tools, memory and skills. "
      + "Use it when the person wants a specific agent (polpo_agents_list for names). Returns a session_id to continue; "
      + "when status is needs_input, answer with polpo_answer.",
    inputSchema: {
      agent: z.string().min(1).describe("The agent's name (polpo_agents_list)"),
      message: z.string().min(1).describe("The message to the agent"),
      session_id: z.string().optional().describe("Continue an earlier conversation with this agent; omit to start a new one"),
    },
    outputSchema: turnOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ agent, message, session_id }, extra) => chatTurn(deps, message, agent, session_id, extra));

  tool("core", "polpo_answer", {
    title: "Answer Polpo",
    description: "Answer what a conversation is waiting for (status needs_input from polpo_ask, polpo_agent_chat or an earlier polpo_answer): "
      + "Polpo's questions (answers), a mission plan (execute, save_draft, refine, cancel), a WhatsApp message or an email ready to send "
      + "(send, refine, cancel) or a secret to save (cancel; the person enters secrets in the dashboard). "
      + "execute and send need confirm: true and act for real: ask the person first. The conversation then goes on and the reply comes back.",
    inputSchema: {
      session_id: z.string().min(1).describe("The conversation that waits (session_id of the result)"),
      pending_id: z.string().optional().describe("pending.id from the result: if given, the answer is applied only if that is still what waits"),
      answers: answersSchema.optional().describe("For questions: one entry per question; unanswered ones are left to Polpo"),
      action: z.enum(["answer", "execute", "save_draft", "refine", "send", "cancel"]).optional()
        .describe("For previews: what to do (pending.actions lists the allowed ones). Default: answer for questions"),
      feedback: z.string().optional().describe("For refine: what to change"),
      confirm: z.boolean().optional().describe("Must be true for execute and send, after the person agreed"),
    },
    outputSchema: turnOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ session_id, pending_id, answers, action, feedback, confirm }, extra) => {
    const stored = await sessionMessages(deps, session_id);
    if (!stored.ok) return fail(stored.status === 404 ? `There is no conversation ${session_id}: pass the session_id of the result that asked.` : `Could not load conversation ${session_id}: ${stored.error}`);
    const pending = pendingOfMessages(deps, stored.messages);
    if (!pending) return fail(`Nothing is waiting for an answer in conversation ${session_id}: it moved on. Use polpo_ask with session_id to continue it.`);
    if (pending_id && pending.id && pending_id !== pending.id) return fail(`The conversation now waits for something else (pending_id ${pending.id}, ${pending.kind}): read it with polpo_ask or answer that one.`);
    const act = action ?? (pending.kind === "questions" ? "answer" : undefined);
    if (!act || !(pending.actions as readonly string[]).includes(act)) {
      return fail(`It waits for ${pending.kind}: action must be one of ${pending.actions.join(", ")}.${pending.kind === "vault_preview" && pending.dashboard_url ? ` To save the secret, the person opens ${pending.dashboard_url}.` : ""}`);
    }
    const session = await sessionAgent(deps, session_id);
    if (!session.ok) return fail(`${session.error}: pass the session_id of the result that asked.`);
    const agent = session.agent;
    const go = (message: string, done?: Record<string, unknown>) => chatTurn(deps, message, agent, session_id, extra, done);

    if (act === "refine") {
      if (!feedback?.trim()) return fail("refine needs feedback: what should change.");
      const what = pending.kind === "mission_preview" ? "Please refine the mission plan with these changes:\n"
        : pending.kind === "email_preview" ? "Please revise the email before sending: " : "Please revise the WhatsApp message before sending: ";
      return go(`${what}${feedback.trim()}`);
    }

    switch (pending.kind) {
      case "questions": {
        const known = new Map((pending.questions ?? []).map((q) => [q.id, q]));
        const unknown = (answers ?? []).filter((a) => !known.has(a.question_id)).map((a) => a.question_id);
        if (unknown.length) return fail(`Unknown question ids: ${unknown.join(", ")}. The questions are: ${[...known.keys()].join(", ")}.`);
        if (!answers?.length) return fail(`Give answers: [{ question_id, selected?, text? }] for ${[...known.keys()].join(", ")}.`);
        const lines = (pending.questions ?? []).map((q) => {
          const a = answers.find((x) => x.question_id === q.id);
          const parts = [...(a?.selected?.length ? [a.selected.join(", ")] : []), ...(a?.text?.trim() ? [a.text.trim()] : [])];
          return `${q.header || q.question || q.id}: ${parts.length ? parts.join(" — ") : "Skipped — decide on your own based on best practices"}`;
        });
        return go(lines.join("\n"));
      }
      case "mission_preview": {
        const m = pending.mission!;
        if (act === "cancel") return go(`I decided not to proceed with the proposed mission "${m.name}". Let's move on.`);
        if (act === "execute" && confirm !== true) return fail("Executing a mission starts its tasks: show the plan to the person and, if they agree, call again with confirm: true.");
        const created = await apiSend(deps, "POST", "/missions", {
          data: typeof m.plan === "string" ? m.plan : JSON.stringify(m.plan), name: m.name, ...(m.prompt ? { prompt: m.prompt } : {}), status: "draft",
        });
        if (!created.ok) return go(`Failed to save the mission: ${created.error}`);
        const mission = created.data as { id: string; name: string };
        if (act === "save_draft") {
          return go(`I saved the mission "${mission.name}" (ID: ${mission.id}) as draft. Don't execute it yet — I might want to review or schedule it first.`,
            { mission_id: mission.id, mission_status: "draft" });
        }
        const run = await apiSend(deps, "POST", `/missions/${enc(mission.id)}/execute`);
        if (!run.ok) return go(`Failed to execute mission "${mission.name}" (ID: ${mission.id}): ${run.error}`, { mission_id: mission.id, mission_status: "draft" });
        return go(`I approved and executed the mission "${mission.name}" (ID: ${mission.id}). It's now running. Please acknowledge and let me know if there's anything else to do.`,
          { mission_id: mission.id, mission_status: "running" });
      }
      case "whatsapp_preview": {
        const w = pending.whatsapp!;
        if (act === "cancel") return go(`I declined the WhatsApp send to ${String(w.to)}. Let's move on.`);
        if (confirm !== true) return fail("Sending is real and cannot be undone: show the message to the person and, if they agree, call again with confirm: true.");
        const { kind, ...fields } = w;
        const sent = await apiSend(deps, "POST", kind === "file" ? "/whatsapp/send-file" : "/whatsapp/send", fields);
        if (!sent.ok) return go(`WhatsApp send failed: ${sent.error}. Don't retry automatically — wait for new instructions.`, { sent: false });
        const id = str((sent.data as { id?: unknown })?.id);
        return go(`I confirmed the WhatsApp ${kind === "file" ? "file " : ""}send to ${String(w.to)}. Message ${id ? `id ${id}` : "sent"}. Continue with the final answer.`, { sent: true, ...(id ? { message_id: id } : {}) });
      }
      case "email_preview": {
        const e = pending.email!;
        const to = Array.isArray(e.to) ? e.to.join(", ") : String(e.to);
        if (act === "cancel") return go(`I declined the email send to ${to}. Let's move on.`);
        if (confirm !== true) return fail("Sending is real and cannot be undone: show the email to the person and, if they agree, call again with confirm: true.");
        const sent = await apiSend(deps, "POST", "/email/send", { ...e, ...(agent ? { agent } : {}), sessionId: session_id });
        if (!sent.ok) return go(`Email send failed: ${sent.error}. Don't retry automatically — wait for new instructions.`, { sent: false });
        const id = str((sent.data as { id?: unknown })?.id);
        return go(`I confirmed the email send to ${to} with subject "${String(e.subject)}". Message ${id ? `id ${id}` : "sent"}. Continue with the final answer.`, { sent: true, ...(id ? { message_id: id } : {}) });
      }
      case "vault_preview": {
        const v = pending.vault!;
        return go(`Declined saving vault entry for "${v.service}" on agent "${v.agent}" from this client: secrets are entered in the dashboard${pending.dashboard_url ? ` (${pending.dashboard_url})` : ""}.`);
      }
    }
  });
}
