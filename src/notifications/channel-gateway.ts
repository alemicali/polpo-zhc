/**
 * Channel Gateway — routes inbound messages from messaging channels to the orchestrator.
 *
 * This extends the existing TelegramCallbackPoller pattern from "approval-only" to a
 * full conversational gateway, inspired by OpenClaw's multi-channel architecture but
 * adapted for Polpo's orchestrator-centric model.
 *
 * Capabilities:
 *   - Inbound message routing from Telegram (WhatsApp/Slack/Discord ready to extend)
 *   - Peer identity resolution and DM policy enforcement (allowlist/pairing)
 *   - One-time invite links (/start <token>) that pair a peer without codes
 *   - Session management per peer and interlocutor, optionally shared with the web UI
 *   - Slash commands (/tasks, /status, /missions, /approve, /new, /agent, /polpo)
 *   - Free-text chat to the orchestrator, or to a single agent via the chat runner
 *   - Approval inline buttons (preserves existing TelegramCallbackPoller behavior)
 *   - Presence tracking
 *
 * Architecture:
 *   TelegramCallbackPoller (existing, approval-only)
 *     └── ChannelGateway (this file, full message routing)
 *           ├── PeerStore (identity, allowlist, pairing, session mapping)
 *           ├── SessionStore (conversation persistence)
 *           ├── Orchestrator (for commands: tasks, missions, agents, approvals)
 *           └── Chat completions (for free-text conversation)
 */

import { nanoid } from "nanoid";
import type { Orchestrator } from "../core/orchestrator.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { ApprovalCallbackResolver, InboundAttachment } from "./channels/telegram.js";
import type {
  ChannelGatewayConfig,
  ChannelType,
  NotificationChannelConfig,
} from "../core/types.js";
import { resolveModel, resolveModelSpec, buildStreamOpts, streamSimpleWithAuth } from "../llm/pi-client.js";
import { buildChatSystemPrompt } from "../llm/prompts.js";
import type { Message } from "@earendil-works/pi-ai";
import {
  ALL_ORCHESTRATOR_TOOLS,
  executeOrchestratorTool,
} from "../llm/orchestrator-tools.js";

// ── Types ───────────────────────────────────────────────────────────────

export interface ChannelGatewayOptions {
  orchestrator: Orchestrator;
  peerStore: PeerStore;
  sessionStore: SessionStore;
  channelConfig: NotificationChannelConfig;
  approvalResolver?: ApprovalCallbackResolver;
  /** Called periodically during long-running operations (e.g. to send typing indicators). */
  onTyping?: (chatId: string) => Promise<void>;
}

interface InboundMessage {
  channel: ChannelType;
  externalId: string;         // sender's channel-specific ID
  chatId: string;             // chat/group ID (may differ from externalId in groups)
  displayName?: string;
  text: string;
  messageId?: string;
  /** Media downloaded from the channel (photos, documents, voice notes, …). */
  attachments?: InboundAttachment[];
}

interface CommandResult {
  text: string;
  parseMode?: "HTML" | "Markdown";
}

/** OpenAI-format content part, as accepted by the completions pipeline. */
export type ChannelContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

/** Chat turn executed by the host (the server's completions pipeline). */
export interface ChannelChatRequest {
  /** Target agent; omitted = the orchestrator. */
  agent?: string;
  sessionId: string;
  /** Conversation history including the new user message, oldest first. */
  messages: { role: "user" | "assistant"; content: string | ChannelContentPart[] }[];
}

/** Runs one agent-direct chat turn and returns the reply. The host persists both messages. */
export type ChannelChatRunner = (request: ChannelChatRequest) => Promise<{ text: string }>;

/** One-time link that pairs whoever opens it (e.g. t.me/<bot>?start=<token>). */
export interface ChannelInvite {
  token: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "paired" | "expired";
  peerId?: string;
  externalId?: string;
  chatId?: string;
  displayName?: string;
}

const INVITE_TTL_MS = 15 * 60 * 1000;
/** Per-file limit of the chat attachment store (saveChatUserMessage). */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const VISION_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const ATTACHMENT_LABEL: Record<InboundAttachment["kind"], string> = {
  photo: "a photo", document: "a file", voice: "a voice message", audio: "an audio file", video: "a video",
};

/** Build the user turn: caption (or a short description) plus image/file parts. */
export function attachmentContent(text: string, attachments: InboundAttachment[]): ChannelContentPart[] {
  const described = attachments.map(a => `${ATTACHMENT_LABEL[a.kind]} (${a.filename})`).join(", ");
  const voiceHint = attachments.some(a => a.kind === "voice" || a.kind === "audio")
    ? " Audio is attached as a file; transcribe it with your tools if you can, otherwise say you cannot listen to it."
    : "";
  const parts: ChannelContentPart[] = [{ type: "text", text: text.trim() || `[The user sent ${described}.${voiceHint}]` }];
  if (text.trim() && voiceHint) parts.push({ type: "text", text: `[${voiceHint.trim()}]` });
  for (const a of attachments) {
    const dataUrl = `data:${a.mimeType};base64,${a.data.toString("base64")}`;
    parts.push(VISION_TYPES.has(a.mimeType)
      ? { type: "image_url", image_url: { url: dataUrl } }
      : { type: "file", file: { filename: a.filename, file_data: dataUrl } });
  }
  return parts;
}
const START_TOKEN = /^\/start(?:@\S+)?\s+([A-Za-z0-9_-]{8,64})\s*$/;

// ── Slash Commands ──────────────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  "/help":    "Show available commands",
  "/status":  "Show orchestrator status (running tasks, agents)",
  "/tasks":   "List all tasks with status",
  "/missions": "List all missions",
  "/agents":  "List all agents",
  "/approve": "Approve a pending approval (usage: /approve REQUEST_ID)",
  "/reject":  "Reject a pending approval (usage: /reject REQUEST_ID [reason])",
  "/new":     "Reset your conversation session",
  "/agent":   "Talk directly to an agent (usage: /agent NAME)",
  "/polpo":   "Go back to talking with the orchestrator",
  "/pair":    "Approve a pairing code (usage: /pair CODE)",
};

// ── Channel Gateway ─────────────────────────────────────────────────────

export class ChannelGateway {
  private orchestrator: Orchestrator;
  private peerStore: PeerStore;
  private sessionStore: SessionStore;
  private gatewayConfig: ChannelGatewayConfig;
  private channelConfig: NotificationChannelConfig;
  private approvalResolver?: ApprovalCallbackResolver;
  private pendingRevise = new Map<string, string>(); // chatId → approvalRequestId
  private recentMessageIds = new Set<string>(); // dedup guard for duplicate polls
  private onTyping?: (chatId: string) => Promise<void>;
  private onPartialResponse?: (chatId: string, text: string) => Promise<void>;
  private invites = new Map<string, ChannelInvite>(); // token → invite (in-memory, short-lived)
  private forceNewSession = new Set<string>(); // session keys reset by /new in shared mode

  constructor(opts: ChannelGatewayOptions) {
    this.orchestrator = opts.orchestrator;
    this.peerStore = opts.peerStore;
    this.sessionStore = opts.sessionStore;
    this.channelConfig = opts.channelConfig;
    this.gatewayConfig = opts.channelConfig.gateway ?? {};
    this.approvalResolver = opts.approvalResolver;
    this.onTyping = opts.onTyping;
  }

  /** Emit a structured log via the orchestrator's event bus. */
  private log(level: "info" | "warn" | "verbose", message: string): void {
    try {
      (this.orchestrator as any).emit("log", { level, message: `[gateway] ${message}` });
    } catch { /* emitter may not be available */ }
  }

  /** Set a callback to send partial responses as separate messages (e.g. Telegram messages). */
  setPartialResponseHandler(handler: (chatId: string, text: string) => Promise<void>): void {
    this.onPartialResponse = handler;
  }

  /**
   * Handle an inbound message from any channel.
   * Returns a response string to send back, or undefined to ignore.
   */
  async handleMessage(msg: InboundMessage): Promise<string | undefined> {
    if (!this.gatewayConfig.enableInbound) return undefined;

    // Dedup: skip if we've already processed this exact message
    if (msg.messageId) {
      const dedupKey = `${msg.channel}:${msg.messageId}`;
      if (this.recentMessageIds.has(dedupKey)) return undefined;
      this.recentMessageIds.add(dedupKey);
      // Cap the set to prevent unbounded growth
      if (this.recentMessageIds.size > 500) {
        const first = this.recentMessageIds.values().next().value!;
        this.recentMessageIds.delete(first);
      }
    }

    const peerId = `${msg.channel}:${msg.externalId}`;

    // Upsert peer identity
    await this.peerStore.upsertPeer({
      channel: msg.channel,
      externalId: msg.externalId,
      displayName: msg.displayName,
      lastSeenAt: new Date().toISOString(),
    });

    // Update presence
    this.peerStore.updatePresence(peerId, "chatting");

    // ── One-time invite link (/start <token>) — pairs without a code ──
    const invite = this.matchInvite(msg.text);
    if (invite) return this.redeemInvite(invite, msg, peerId);

    // ── DM Policy enforcement ──
    if (!await this.peerStore.isAllowed(peerId, this.gatewayConfig)) {
      return this.handleUnauthorized(msg, peerId);
    }

    // ── Check for pending approval rejection feedback ──
    const pendingRequestId = this.pendingRevise.get(msg.chatId);
    if (pendingRequestId && this.approvalResolver) {
      this.pendingRevise.delete(msg.chatId);
      const result = await this.approvalResolver.reject(pendingRequestId, msg.text, peerId);
      return result.ok
        ? `Rejected — task will retry with your feedback:\n${msg.text}`
        : `Error: ${result.error}`;
    }

    // ── Slash commands ──
    if (msg.text.startsWith("/")) {
      const result = await this.handleCommand(msg, peerId);
      if (result) return result.text;
    }

    // ── Free-text chat → orchestrator completions ──
    return this.handleChat(msg, peerId);
  }

  /**
   * Handle approval button callbacks (preserves existing TelegramCallbackPoller behavior).
   */
  async handleApprovalCallback(action: string, requestId: string, chatId: string, resolvedBy: string): Promise<string> {
    if (!this.approvalResolver) return "No approval resolver configured";

    if (action === "approve") {
      const result = await this.approvalResolver.approve(requestId, resolvedBy);
      return result.ok ? "Approved successfully" : `Error: ${result.error}`;
    } else if (action === "reject") {
      this.pendingRevise.set(chatId, requestId);
      return "Rejected — tell the agent why. Reply with your feedback:";
    }
    return "Unknown action";
  }

  // ── Invite links ──────────────────────────────────────────────────

  /** Create a one-time invite. Whoever sends `/start <token>` first is paired. */
  createInvite(ttlMs = INVITE_TTL_MS): ChannelInvite {
    this.pruneInvites();
    const now = Date.now();
    const invite: ChannelInvite = {
      token: nanoid(24),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      status: "pending",
    };
    this.invites.set(invite.token, invite);
    return invite;
  }

  /** Current state of an invite, or undefined if unknown (never created or pruned). */
  getInvite(token: string): ChannelInvite | undefined {
    const invite = this.invites.get(token);
    if (invite?.status === "pending" && Date.now() > new Date(invite.expiresAt).getTime()) {
      invite.status = "expired";
    }
    return invite;
  }

  private matchInvite(text: string): ChannelInvite | undefined {
    const token = START_TOKEN.exec(text.trim())?.[1];
    if (!token) return undefined;
    const invite = this.getInvite(token);
    return invite?.status === "pending" ? invite : undefined;
  }

  private async redeemInvite(invite: ChannelInvite, msg: InboundMessage, peerId: string): Promise<string | undefined> {
    if ((this.gatewayConfig.dmPolicy ?? "allowlist") === "disabled") return undefined;

    await this.peerStore.addToAllowlist(peerId);
    const pending = await this.peerStore.getPendingPairing(peerId);
    if (pending) await this.peerStore.resolvePairing(pending.code);

    invite.status = "paired";
    invite.peerId = peerId;
    invite.externalId = msg.externalId;
    invite.chatId = msg.chatId;
    invite.displayName = msg.displayName;
    this.log("info", `Invite redeemed by ${peerId}`);

    const dedicated = this.gatewayConfig.agent;
    return dedicated
      ? `Connected${msg.displayName ? `, ${msg.displayName}` : ""}! You can now talk to ${dedicated} here.`
      : `Connected${msg.displayName ? `, ${msg.displayName}` : ""}! You can now talk to Polpo here.\n\nSend /help to see the commands, or /agent NAME to talk to a specific agent.`;
  }

  private pruneInvites(): void {
    const cutoff = Date.now() - INVITE_TTL_MS;
    for (const [token, invite] of this.invites) {
      if (new Date(invite.expiresAt).getTime() < cutoff) this.invites.delete(token);
    }
  }

  // ── Unauthorized handler ──────────────────────────────────────────

  private async handleUnauthorized(msg: InboundMessage, peerId: string): Promise<string | undefined> {
    const policy = this.gatewayConfig.dmPolicy ?? "allowlist";

    if (policy === "disabled") return undefined; // Silent ignore

    if (policy === "pairing") {
      // Check if already has a pending request
      const existing = await this.peerStore.getPendingPairing(peerId);
      if (existing) {
        return `Your pairing request is pending approval.\nCode: ${existing.code}\nAsk the administrator to run: /pair ${existing.code}`;
      }

      // Create a new pairing request
      const request = await this.peerStore.createPairingRequest(
        msg.channel,
        msg.externalId,
        msg.displayName,
      );
      return `Hi${msg.displayName ? ` ${msg.displayName}` : ""}! I don't recognize you yet.\n\nYour pairing code: ${request.code}\n\nAsk the administrator to approve you with: /pair ${request.code}\nThis code expires in 1 hour.`;
    }

    // allowlist policy — silent block
    return undefined;
  }

  // ── Command handler ───────────────────────────────────────────────

  private async handleCommand(msg: InboundMessage, peerId: string): Promise<CommandResult | undefined> {
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "/help":
        return this.cmdHelp();
      case "/status":
        return this.cmdStatus();
      case "/tasks":
        return this.cmdTasks();
      case "/missions":
        return this.cmdMissions();
      case "/agents":
        return this.cmdAgents();
      case "/approve":
        return this.cmdApprove(args, peerId);
      case "/reject":
        return this.cmdReject(args, peerId, msg.chatId);
      case "/new":
        return this.cmdNewSession(peerId);
      case "/agent":
        return this.cmdAgent(args, peerId);
      case "/polpo":
        return this.cmdPolpo(peerId);
      case "/pair":
        return this.cmdPair(args, peerId);
      default:
        // Unknown command — fall through to chat
        return undefined;
    }
  }

  private cmdHelp(): CommandResult {
    const lines = Object.entries(COMMANDS)
      .map(([cmd, desc]) => `${cmd} — ${desc}`);
    return { text: `Available commands:\n\n${lines.join("\n")}` };
  }

  private async cmdStatus(): Promise<CommandResult> {
    const tasks = await this.orchestrator.getStore().getAllTasks();
    const pending = tasks.filter(t => t.status === "pending").length;
    const running = tasks.filter(t => t.status === "in_progress").length;
    const done = tasks.filter(t => t.status === "done").length;
    const failed = tasks.filter(t => t.status === "failed").length;
    const agents = await this.orchestrator.getAgents();
    const state = await this.orchestrator.getStore().getState();
    const processes = state?.processes ?? [];

    const presenceList = await this.peerStore.getPresence();

    return {
      text: [
        `Project: ${this.orchestrator.getConfig()?.project ?? "unknown"}`,
        "",
        `Tasks: ${pending} pending, ${running} running, ${done} done, ${failed} failed`,
        `Agents: ${agents.length} configured, ${processes.filter((p: { alive: boolean }) => p.alive).length} active`,
        presenceList.length > 0 ? `\nConnected peers: ${presenceList.map(p => p.displayName ?? p.peerId).join(", ")}` : "",
      ].filter(Boolean).join("\n"),
    };
  }

  private async cmdTasks(): Promise<CommandResult> {
    const tasks = await this.orchestrator.getStore().getAllTasks();
    if (tasks.length === 0) return { text: "No tasks." };

    const statusEmoji: Record<string, string> = {
      pending: "⏳", running: "🔄", done: "✅", failed: "❌",
      assigned: "📋", awaiting_approval: "⏸",
    };

    const lines = tasks.slice(0, 20).map(t => {
      const emoji = statusEmoji[t.status] ?? "•";
      return `${emoji} ${t.title} (${t.status})`;
    });

    if (tasks.length > 20) lines.push(`\n... and ${tasks.length - 20} more`);
    return { text: lines.join("\n") };
  }

  private async cmdMissions(): Promise<CommandResult> {
    const missions = await this.orchestrator.getAllMissions();
    if (missions.length === 0) return { text: "No missions." };

    const lines = missions.slice(0, 10).map(m =>
      `• ${m.name} (${m.status})`,
    );
    return { text: lines.join("\n") };
  }

  private async cmdAgents(): Promise<CommandResult> {
    const agents = await this.orchestrator.getAgents();
    const state = await this.orchestrator.getStore().getState();
    const processes = state?.processes ?? [];

    const lines = agents.map(a => {
      const proc = processes.find((p: { agentName: string; alive: boolean }) => p.agentName === a.name && p.alive);
      const status = proc ? "🟢 active" : "⚪ idle";
      return `${status} ${a.name} (${a.role})`;
    });
    return { text: lines.join("\n") || "No agents configured." };
  }

  private async cmdApprove(args: string[], peerId: string): Promise<CommandResult> {
    if (!this.approvalResolver) return { text: "Approval system not configured." };
    if (args.length === 0) {
      // List pending approvals — iterate store for pending requests
      const pendingRequests: { id: string; gateName: string; taskId?: string }[] = [];
      const store = this.orchestrator.getStore();
      const tasks = (await store.getAllTasks()).filter(t => t.status === "awaiting_approval");
      for (const t of tasks) {
        const req = await this.orchestrator.getApprovalRequest(t.id);
        if (req && req.status === "pending") {
          pendingRequests.push({ id: req.id, gateName: req.gateName, taskId: req.taskId });
        }
      }
      if (pendingRequests.length === 0) return { text: "No pending approvals." };
      const lines = pendingRequests.map(r => `• ${r.id.slice(0, 8)}... — ${r.gateName} (task: ${r.taskId ?? "n/a"})`);
      return { text: `Pending approvals:\n\n${lines.join("\n")}\n\nUsage: /approve REQUEST_ID` };
    }
    const requestId = args[0];
    const result = await this.approvalResolver.approve(requestId, peerId);
    return { text: result.ok ? `Approved: ${requestId}` : `Error: ${result.error}` };
  }

  private async cmdReject(args: string[], peerId: string, chatId: string): Promise<CommandResult> {
    if (!this.approvalResolver) return { text: "Approval system not configured." };
    if (args.length === 0) return { text: "Usage: /reject REQUEST_ID [reason]" };

    const requestId = args[0];
    const feedback = args.slice(1).join(" ");

    if (!feedback) {
      this.pendingRevise.set(chatId, requestId);
      return { text: `Rejecting ${requestId.slice(0, 8)}... — reply with your feedback:` };
    }

    const result = await this.approvalResolver.reject(requestId, feedback, peerId);
    return { text: result.ok ? `Rejected: ${requestId} — ${feedback}` : `Error: ${result.error}` };
  }

  private async cmdNewSession(peerId: string): Promise<CommandResult> {
    const agent = await this.getActiveAgent(peerId);
    const key = await this.sessionKey(peerId, agent);
    await this.peerStore.clearSession(key);
    this.forceNewSession.add(key);
    return { text: `Session reset. Your next message starts a new conversation with ${agent ?? "Polpo"}.` };
  }

  private dedicatedMessage(): CommandResult {
    return { text: `This bot is dedicated to ${this.gatewayConfig.agent}. Use the main bot to talk to Polpo or other agents.` };
  }

  private async cmdAgent(args: string[], peerId: string): Promise<CommandResult> {
    if (this.gatewayConfig.agent) return this.dedicatedMessage();
    const agents = await this.orchestrator.getAgents();
    if (args.length === 0) {
      const current = await this.getActiveAgent(peerId);
      const names = agents.map(a => a.name).join(", ") || "none";
      return {
        text: `You are talking to ${current ?? "Polpo (orchestrator)"}.\n\nUsage: /agent NAME — switch to an agent\n/polpo — back to the orchestrator\n\nAgents: ${names}`,
      };
    }

    const wanted = args[0].toLowerCase();
    const agent = agents.find(a => a.name.toLowerCase() === wanted);
    if (!agent) {
      return { text: `Agent "${args[0]}" not found. Send /agents to see the available agents.` };
    }
    if (!this.getChatRunner()) {
      return { text: "Direct agent chat is not available on this instance." };
    }

    await this.peerStore.setSessionId(await this.activeAgentKey(peerId), agent.name);
    return { text: `You are now talking to ${agent.name} (${agent.role}).\nSend /polpo to go back to the orchestrator.` };
  }

  private async cmdPolpo(peerId: string): Promise<CommandResult> {
    if (this.gatewayConfig.agent) return this.dedicatedMessage();
    await this.peerStore.clearSession(await this.activeAgentKey(peerId));
    return { text: "You are now talking to Polpo (orchestrator)." };
  }

  // ── Interlocutor and session resolution ────────────────────────────

  private getChatRunner(): ChannelChatRunner | undefined {
    return this.orchestrator.getChannelChatRunner?.();
  }

  /**
   * Agent the peer is talking to, or undefined for the orchestrator. A dedicated
   * channel always targets its agent; stale selections fall back to the orchestrator.
   */
  private async getActiveAgent(peerId: string): Promise<string | undefined> {
    if (this.gatewayConfig.agent) return this.gatewayConfig.agent;
    const name = await this.peerStore.getSessionId(await this.activeAgentKey(peerId));
    if (!name) return undefined;
    const agents = await this.orchestrator.getAgents();
    return agents.some(a => a.name === name) ? name : undefined;
  }

  // The peer→session map doubles as per-peer state: the canonical peer id keys the
  // orchestrator session, "#agent:<name>" keys agent sessions and "#active-agent"
  // stores the selected interlocutor. Linked identities share all three.
  private async activeAgentKey(peerId: string): Promise<string> {
    return `${await this.peerStore.resolveCanonicalId(peerId)}#active-agent`;
  }

  private async sessionKey(peerId: string, agent?: string): Promise<string> {
    const canonical = await this.peerStore.resolveCanonicalId(peerId);
    return agent ? `${canonical}#agent:${agent}` : canonical;
  }

  /** Channel defaults with the agent's overrides applied (the orchestrator uses the defaults). */
  private sessionSettings(agent?: string): { sessionMode: "per-peer" | "shared"; idleMinutes: number } {
    const override = agent ? this.gatewayConfig.agentSessions?.[agent] : undefined;
    return {
      sessionMode: override?.sessionMode ?? this.gatewayConfig.sessionMode ?? "per-peer",
      idleMinutes: override?.sessionIdleMinutes ?? this.gatewayConfig.sessionIdleMinutes ?? 60,
    };
  }

  /**
   * Session for this peer and interlocutor. "per-peer" keeps a channel-owned
   * session; "shared" continues the interlocutor's latest session, the same
   * one the web UI resumes. Both start fresh after the idle timeout, unless
   * it is 0 (never expire).
   */
  private async resolveSessionId(peerId: string, agent: string | undefined, firstText: string): Promise<string> {
    const key = await this.sessionKey(peerId, agent);
    const { sessionMode, idleMinutes } = this.sessionSettings(agent);
    const isFresh = (updatedAt: string) =>
      idleMinutes === 0 || Date.now() - new Date(updatedAt).getTime() <= idleMinutes * 60 * 1000;
    const forceNew = this.forceNewSession.delete(key);

    let sessionId: string | undefined;
    if (!forceNew) {
      if (sessionMode === "shared") {
        const latest = await this.sessionStore.getLatestSession(agent ?? null);
        if (latest && isFresh(latest.updatedAt)) sessionId = latest.id;
      } else {
        const mapped = await this.peerStore.getSessionId(key);
        const session = mapped ? await this.sessionStore.getSession(mapped) : undefined;
        if (session && isFresh(session.updatedAt)) sessionId = session.id;
      }
    }

    if (!sessionId) sessionId = await this.sessionStore.create(firstText.slice(0, 60), agent);
    await this.peerStore.setSessionId(key, sessionId);
    return sessionId;
  }

  private async cmdPair(args: string[], peerId: string): Promise<CommandResult> {
    if (args.length === 0) return { text: "Usage: /pair CODE" };

    // Only allowed peers can approve pairings (primitive admin check)
    if (!await this.peerStore.isAllowed(peerId, this.gatewayConfig)) {
      return { text: "You must be an authorized peer to approve pairings." };
    }

    const request = await this.peerStore.resolvePairing(args[0]);
    if (!request) return { text: "Invalid or expired pairing code." };

    return { text: `Approved! ${request.displayName ?? request.externalId} (${request.channel}) can now message the bot.` };
  }

  // ── Chat handler (free-text → orchestrator completions) ───────────

  private async handleChat(msg: InboundMessage, peerId: string): Promise<string | undefined> {
    try {
      const agent = await this.getActiveAgent(peerId);
      const attachments = msg.attachments ?? [];
      const title = msg.text || attachments.map(a => a.filename).join(", ");
      const sessionId = await this.resolveSessionId(peerId, agent, title);
      // Agents, and any turn with media, go through the host pipeline (vision + attachment storage).
      if (agent || attachments.length > 0) return await this.handleRunnerChat(msg, agent, sessionId);

      // Store user message
      await this.sessionStore.addMessage(sessionId, "user", msg.text);

      // Build conversation history from session
      // Note: pi-ai uses "user" role for both user and assistant messages.
      // Assistant messages are wrapped with a prefix, matching the completions endpoint behavior.
      const recentMessages = await this.sessionStore.getRecentMessages(sessionId, 20);
      const piMessages: Message[] = recentMessages
        .filter(m => m.role === "user" || m.role === "assistant")
        .map(m => ({
          role: "user" as const,
          content: m.role === "assistant"
            ? `[Previous assistant response]\n${m.content}\n[End previous response]`
            : m.content,
          timestamp: new Date(m.ts).getTime(),
        }));

      // Get system prompt
      const state = await (async () => {
        try { return await this.orchestrator.getStore()?.getState() ?? null; }
        catch { return null; }
      })();
      const systemPrompt = await buildChatSystemPrompt(this.orchestrator, state);

      // Add peer context
      const peer = await this.peerStore.getPeer(peerId);
      const peerContext = peer
        ? `\n\n## Caller context\nName: ${peer.displayName ?? "Unknown"}\nChannel: ${peer.channel}\nPeer ID: ${peer.id}`
        : "";

      // Resolve model
      const settings = this.orchestrator.getConfig()?.settings;
      const modelSpec = resolveModelSpec(settings?.orchestratorModel);
      const m = resolveModel(modelSpec);
      const streamOpts = buildStreamOpts(undefined, settings?.reasoning, m.maxTokens);

      // Run the agentic loop (non-streaming for messaging)
      const MAX_TURNS = 15;
      const messages: Message[] = [...piMessages];
      let finalText = "";
      let sentPartials = false;



      for (let turn = 0; turn < MAX_TURNS; turn++) {
        this.log("verbose", `Turn ${turn + 1}: sending ${messages.length} messages`);
        const piStream = await streamSimpleWithAuth(m, {
          systemPrompt: systemPrompt + peerContext,
          messages,
          tools: ALL_ORCHESTRATOR_TOOLS,
        }, streamOpts);

        let turnText = "";
        let streamError: string | undefined;
        for await (const event of piStream) {
          if (event.type === "text_delta") {
            turnText += event.delta;
          } else if (event.type === "error") {
            streamError = (event as any).error?.errorMessage ?? "Model error";
          }
        }

        if (streamError) {
          return `Error: ${streamError}`;
        }

        const response = await piStream.result();
        this.log("verbose", `Turn ${turn + 1} complete: ${turnText.length} chars, blocks: ${response.content.map((c: { type: string }) => c.type).join(",")}`);
        messages.push(response);

        const toolCalls = response.content.filter(
          (cc): cc is { type: "toolCall"; id: string; name: string; arguments: Record<string, any> } =>
            cc.type === "toolCall",
        );

        if (toolCalls.length === 0) {
          // No tool calls — this turn's text is the final answer
          finalText += turnText;
          break;
        }

        // There are tool calls — send partial text as a separate message if present
        if (turnText.trim() && this.onPartialResponse) {
          await this.onPartialResponse(msg.chatId, turnText);
          sentPartials = true;
          // Don't add to finalText since it was already sent
        } else {
          finalText += turnText;
        }

        // Send typing indicator while executing tools
        if (this.onTyping) await this.onTyping(msg.chatId);

        for (const call of toolCalls) {

          const result = await executeOrchestratorTool(call.name, call.arguments, this.orchestrator);
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: result }],
            isError: result.startsWith("Error:"),
            timestamp: Date.now(),
          });
        }
      }

      // Store assistant response
      if (finalText) {
        await this.sessionStore.addMessage(sessionId, "assistant", finalText);
      }

      // Telegram has a 4096 char limit
      if (finalText.length > 4000) {
        finalText = finalText.slice(0, 3990) + "\n\n... (truncated)";
      }

      // If all text was already sent as partials, nothing left to return
      if (!finalText && sentPartials) return undefined;
      return finalText || "I processed your request but have nothing to say.";
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return `Sorry, I encountered an error: ${errMsg}`;
    }
  }

  /**
   * Turn through the host's chat pipeline (agent-direct, or orchestrator when
   * agent is undefined). The pipeline persists both messages and attachments.
   */
  private async handleRunnerChat(msg: InboundMessage, agent: string | undefined, sessionId: string): Promise<string> {
    const who = agent ?? "Polpo";
    const runner = this.getChatRunner();
    if (!runner) {
      return agent
        ? "Direct agent chat is not available on this instance. Send /polpo to talk to the orchestrator."
        : "Attachments are not supported on this instance yet. Please send text.";
    }

    const attachments = msg.attachments ?? [];
    const tooLarge = attachments.find(a => a.data.length > MAX_ATTACHMENT_BYTES);
    if (tooLarge) return `${tooLarge.filename} is too large: attachments can be up to 15 MB.`;

    const history = await this.sessionStore.getRecentMessages(sessionId, 40);
    const messages: ChannelChatRequest["messages"] = history
      .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
      .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
    messages.push({ role: "user", content: attachments.length > 0 ? attachmentContent(msg.text, attachments.slice(0, 5)) : msg.text });

    if (this.onTyping) await this.onTyping(msg.chatId);
    const { text } = await runner({ agent, sessionId, messages });

    const reply = text.trim() || `${who} processed your request but has nothing to say.`;
    return reply.length > 4000 ? reply.slice(0, 3990) + "\n\n... (truncated)" : reply;
  }
}
