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
 *   - Reply routing ("conversation pipe"): chat replies can leave from another channel
 *     (gateway.replyTo or per message), e.g. in from a webhook, out on Telegram
 *   - Groups: a group is enabled once (by an authorized person) and then everyone in it can
 *     talk to the agents, in a conversation of its own per group and topic. Only messages
 *     addressed to the bot are answered; the others are kept as context for the next turn.
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
import { sessionLeases } from "@polpo-ai/server";
import type { Orchestrator } from "../core/orchestrator.js";
import type { PeerStore } from "../core/peer-store.js";
import type { SessionStore } from "../core/session-store.js";
import type { ApprovalCallbackResolver, InboundAttachment } from "./channels/telegram.js";
import type { InboundGroup } from "./telegram-groups.js";
import type { GroupIntentArbiter, IntentCandidate } from "./group-intent.js";
import type {
  ChannelGatewayConfig,
  ChannelReplyTarget,
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
  onTyping?: (chatId: string, target?: ChannelSendTarget) => Promise<void>;
  /** Channel key (notifications.channels): names this bot among the group's agents. */
  key?: string;
}

/** Where a message goes inside a chat: a forum topic, as a reply to a message (groups). */
export interface ChannelSendTarget {
  threadId?: number;
  replyTo?: number;
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
  /** Where the chat reply goes: "origin" forces this channel; unset = gateway.replyTo, else origin. */
  replyTo?: ChannelReplyTarget | "origin";
  /** Set when the message was written in a group. */
  group?: InboundGroup;
}

/** A group message that was not addressed to the bot, kept as context for the next turn. */
interface GroupLine { name: string; text: string; at: number }

/** Context lines kept per group conversation, and for how long. */
const GROUP_CONTEXT_LINES = 30;
const GROUP_CONTEXT_MS = 12 * 60 * 60 * 1000;
/** groupReplies "intent": the probability above which an agent joins in unprompted. */
const DEFAULT_INTENT_THRESHOLD = 0.7;
const GROUP_CONTEXT_CONVERSATIONS = 500;

interface CommandResult {
  text: string;
  parseMode?: "HTML" | "Markdown";
  buttons?: ReplyButton[][];
}

/** Inline button rendered under a reply; `data` comes back as a callback (e.g. "agent:backend"). */
export interface ReplyButton { text: string; data: string }

/** Reply with optional inline buttons or a reply prompt, for channels that support them. */
export interface GatewayReply {
  text: string;
  buttons?: ReplyButton[][];
  /** Ask the user to type an answer; the placeholder is shown in the input field. */
  forceReply?: { placeholder?: string };
  /** Files to deliver after the text (channels send them as documents). */
  files?: ChannelOutboundFile[];
  /** Set when the reply was delivered through another channel (nothing to send here). */
  deliveredTo?: string;
}

/** What a reply router delivers to the target channel of a conversation pipe. */
export type ReplyRouteEvent =
  | { kind: "echo"; text: string; from: string; via: ChannelType }
  | { kind: "partial"; text: string }
  | { kind: "reply"; reply: GatewayReply };

/** Delivers pipe events through another channel; provided by the host (orchestrator). */
export type ReplyRouter = (target: ChannelReplyTarget, event: ReplyRouteEvent) => Promise<void>;

/** An agent suggestion exposed as a channel command. */
export interface SuggestionCommand {
  command: string;
  title: string;
  prompt: string;
  /** First [placeholder] in the prompt, filled with the user's next message. */
  placeholder?: string;
}

const PLACEHOLDER = /\[([^\]]+)\]/;
const RESERVED_COMMANDS = new Set(Object.keys({ new: 1, help: 1, start: 1 }));

/** Telegram command name: lowercase a-z, 0-9 and _, at most 32 characters. */
export function commandSlug(title: string): string {
  return title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32).replace(/_+$/, "");
}

/** Agent suggestions as unique commands (reserved names and empty slugs are skipped). */
export function suggestionCommands(suggestions: { title?: string; prompt?: string }[] | undefined): SuggestionCommand[] {
  const seen = new Set<string>(RESERVED_COMMANDS);
  const out: SuggestionCommand[] = [];
  for (const s of suggestions ?? []) {
    if (!s.title || !s.prompt) continue;
    let command = commandSlug(s.title);
    if (!command) continue;
    for (let n = 2; seen.has(command); n++) command = `${commandSlug(s.title).slice(0, 29)}_${n}`;
    seen.add(command);
    out.push({ command, title: s.title, prompt: s.prompt, placeholder: PLACEHOLDER.exec(s.prompt)?.[1] });
  }
  return out;
}

/** Entry of the channel's command menu (Telegram setMyCommands). */
export interface MenuCommand { command: string; description: string }

const ORCHESTRATOR_CHOICE = "__polpo__";

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

/** A file the turn produced for the user (e.g. via open_file), already resolved and checked by the host. */
export interface ChannelOutboundFile { path: string; filename: string }

/** Runs one chat turn and returns the reply. The host persists both messages. */
export type ChannelChatRunner = (request: ChannelChatRequest) => Promise<{ text: string; files?: ChannelOutboundFile[] }>;

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
/** Replies longer than this are cut; channels split the rest into several messages. */
const MAX_REPLY_CHARS = 16_000;
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
  "/enable":  "Let everyone in this group talk to me (authorized people only)",
  "/disable": "Stop answering in this group (authorized people only)",
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
  private onTyping?: (chatId: string, target?: ChannelSendTarget) => Promise<void>;
  private onPartialResponse?: (chatId: string, text: string, target?: ChannelSendTarget) => Promise<void>;
  private groupContext = new Map<string, GroupLine[]>(); // group conversation → recent unaddressed messages
  private invites = new Map<string, ChannelInvite>(); // token → invite (in-memory, short-lived)
  private pendingSuggestion = new Map<string, SuggestionCommand>(); // chatId → suggestion awaiting its placeholder
  private forceNewSession = new Set<string>(); // session keys reset by /new in shared mode
  private replyRouter?: ReplyRouter;
  private partialOverride = new Map<string, (text: string) => Promise<void>>(); // chatId → routed partials
  private key: string;
  private intent?: GroupIntentArbiter;

  constructor(opts: ChannelGatewayOptions) {
    this.orchestrator = opts.orchestrator;
    this.peerStore = opts.peerStore;
    this.sessionStore = opts.sessionStore;
    this.channelConfig = opts.channelConfig;
    this.gatewayConfig = opts.channelConfig.gateway ?? {};
    this.approvalResolver = opts.approvalResolver;
    this.onTyping = opts.onTyping;
    this.key = opts.key ?? "default";
  }

  /** Emit a structured log via the orchestrator's event bus. */
  private log(level: "info" | "warn" | "verbose", message: string): void {
    try {
      (this.orchestrator as any).emit("log", { level, message: `[gateway] ${message}` });
    } catch { /* emitter may not be available */ }
  }

  /** Route chat replies through other channels (gateway.replyTo / InboundMessage.replyTo). */
  setReplyRouter(router: ReplyRouter): void {
    this.replyRouter = router;
  }

  /** Target of the chat reply for this message, or undefined to answer on the origin channel. */
  replyTargetFor(msg: Pick<InboundMessage, "replyTo">): ChannelReplyTarget | undefined {
    if (msg.replyTo === "origin" || !this.replyRouter) return undefined;
    return msg.replyTo ?? this.gatewayConfig.replyTo;
  }

  /** Set a callback to send partial responses as separate messages (e.g. Telegram messages). */
  setPartialResponseHandler(handler: (chatId: string, text: string, target?: ChannelSendTarget) => Promise<void>): void {
    this.onPartialResponse = handler;
  }

  /**
   * Handle an inbound message from any channel.
   * Returns a response string to send back, or undefined to ignore.
   */
  async handleMessage(msg: InboundMessage): Promise<string | undefined> {
    return (await this.handleMessageReply(msg))?.text;
  }

  /** Like handleMessage, keeping inline buttons for channels that can render them. */
  async handleMessageReply(msg: InboundMessage): Promise<GatewayReply | undefined> {
    const reply = await this.routeMessage(msg);
    return typeof reply === "string" ? { text: reply } : reply;
  }

  private async routeMessage(msg: InboundMessage): Promise<string | GatewayReply | undefined> {
    if (!this.gatewayConfig.enableInbound) return undefined;

    // Dedup: skip if we've already processed this exact message (message ids are per chat)
    if (msg.messageId) {
      const dedupKey = `${msg.channel}:${msg.chatId}:${msg.messageId}`;
      if (this.recentMessageIds.has(dedupKey)) return undefined;
      this.recentMessageIds.add(dedupKey);
      // Cap the set to prevent unbounded growth
      if (this.recentMessageIds.size > 500) {
        const first = this.recentMessageIds.values().next().value!;
        this.recentMessageIds.delete(first);
      }
    }

    const peerId = `${msg.channel}:${msg.externalId}`;

    if (msg.group) {
      // ── Groups: the group is the trust boundary, not the person ──
      const admitted = await this.admitGroupMessage(msg, peerId);
      if (admitted !== true) return admitted;
    } else {
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
    }

    // Who the agents talk with: the person in a DM, the group (and topic) in a group.
    const conversation = this.conversationId(msg, peerId);
    const pendingKey = this.pendingKey(msg);

    // ── Check for pending approval rejection feedback ──
    const pendingRequestId = this.pendingRevise.get(pendingKey);
    if (pendingRequestId && this.approvalResolver) {
      this.pendingRevise.delete(pendingKey);
      const result = await this.approvalResolver.reject(pendingRequestId, msg.text, peerId);
      return result.ok
        ? `Rejected — task will retry with your feedback:\n${msg.text}`
        : `Error: ${result.error}`;
    }

    // ── Suggestion waiting for its [placeholder] ──
    const pendingSuggestion = this.pendingSuggestion.get(pendingKey);
    if (pendingSuggestion) {
      this.pendingSuggestion.delete(pendingKey);
      if (!msg.text.startsWith("/")) {
        const filled = pendingSuggestion.prompt.replace(PLACEHOLDER, msg.text.trim());
        return this.handleChat({ ...msg, text: filled }, conversation);
      }
    }

    // ── Slash commands ──
    if (msg.text.startsWith("/")) {
      const suggestion = await this.handleSuggestionCommand(msg, conversation);
      if (suggestion) return suggestion;
      const result = await this.handleCommand(msg, peerId, conversation);
      if (result) return result.buttons ? { text: result.text, buttons: result.buttons } : result.text;
    }

    // ── Free-text chat → orchestrator completions ──
    return this.handleChat(msg, conversation);
  }

  // ── Groups ────────────────────────────────────────────────────────

  /** Allowlist entry and peer id of a group (all of this instance's bots share it). */
  private groupId(msg: Pick<InboundMessage, "channel" | "chatId">): string {
    return `${msg.channel}:group:${msg.chatId}`;
  }

  /** Conversation key: the person in a DM; the group, and its topic, in a group. */
  private conversationId(msg: InboundMessage, peerId: string): string {
    if (!msg.group) return peerId;
    return msg.group.threadId !== undefined ? `${this.groupId(msg)}:topic:${msg.group.threadId}` : this.groupId(msg);
  }

  // ── Groups: joining in by intent ──────────────────────────────────

  /** The instance's group arbiter (gateway.groupReplies = "intent"). */
  setIntentArbiter(arbiter: GroupIntentArbiter): void {
    this.intent = arbiter;
  }

  private intentMode(): boolean {
    return this.gatewayConfig.groupReplies === "intent" && !!this.intent?.available;
  }

  /**
   * This bot as one of the agents of a group conversation, when it answers by intent there:
   * intent mode on and the group enabled. The orchestrator's bot speaks as Polpo.
   */
  async intentCandidate(conversation: string): Promise<IntentCandidate | undefined> {
    if (this.gatewayConfig.groupReplies !== "intent") return undefined;
    const groupId = conversation.replace(/:topic:.*$/, "");
    if (!await this.peerStore.isAllowed(groupId, this.gatewayConfig)) return undefined;
    const name = this.gatewayConfig.agent;
    if (!name) {
      return {
        key: this.key,
        name: "Polpo",
        role: "the orchestrator: plans and coordinates the company's work, assigns tasks to the agents, answers about tasks, missions and agents",
        responsibilities: [],
      };
    }
    const agent = (await this.orchestrator.getAgents()).find(a => a.name === name);
    const id = agent?.identity;
    const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    return {
      key: this.key,
      name: id?.displayName ?? name,
      role: short(id?.title ?? agent?.role ?? "an agent of the company", 160),
      responsibilities: (id?.responsibilities ?? []).map(r => short(typeof r === "string" ? r : `${r.area}: ${r.description}`, 160)),
    };
  }

  /**
   * An unaddressed group message: should this bot answer it anyway? Asked before the message is
   * kept as context. True only in intent mode, in an enabled group, above the threshold.
   */
  async joinsByIntent(msg: InboundMessage): Promise<boolean> {
    if (!msg.group || msg.group.addressed || !this.intentMode() || !msg.messageId) return false;
    if (!msg.text.trim() || msg.text.startsWith("/")) return false;
    const conversation = this.conversationId(msg, `${msg.channel}:${msg.externalId}`);
    const me = await this.intentCandidate(conversation);
    if (!me) return false;
    const now = Date.now();
    const earlier = (this.groupContext.get(conversation) ?? []).filter(l => now - l.at < GROUP_CONTEXT_MS);
    const decision = await this.intent!.decide({
      conversation,
      messageId: msg.messageId,
      title: msg.group.title,
      speaker: msg.displayName ?? msg.externalId,
      text: msg.text,
      earlier: earlier.map(l => ({ name: l.name, text: l.text })),
    }, me);
    const p = decision[this.key] ?? 0;
    return p >= (this.gatewayConfig.intentThreshold ?? DEFAULT_INTENT_THRESHOLD);
  }

  /** Key of per-person pending state (reject feedback, suggestion placeholder). */
  private pendingKey(msg: Pick<InboundMessage, "chatId" | "externalId" | "group">): string {
    return msg.group ? `${msg.chatId}:${msg.externalId}` : msg.chatId;
  }

  /** In groups replies go to the message's topic, quoting it. */
  private sendTarget(msg: InboundMessage): ChannelSendTarget | undefined {
    if (!msg.group) return undefined;
    const replyTo = msg.messageId && /^\d+$/.test(msg.messageId) ? Number(msg.messageId) : undefined;
    return { threadId: msg.group.threadId, replyTo };
  }

  /**
   * A person trusted on their own (paired, invited, or in the channel's allowFrom), whatever the
   * DM policy: needed to enable or disable a group, and for approvals and pairing inside groups.
   */
  private personAuthorized(peerId: string): Promise<boolean> {
    return this.peerStore.isAllowed(peerId, { ...this.gatewayConfig, dmPolicy: "allowlist" });
  }

  private interlocutorName(): string {
    return this.gatewayConfig.agent ?? "Polpo";
  }

  /**
   * Group messages: the unaddressed ones become context, the addressed ones are answered once
   * the group is enabled. Returns true to continue routing, or what to answer (if anything).
   */
  private async admitGroupMessage(msg: InboundMessage, peerId: string): Promise<true | string | undefined> {
    const enabled = await this.peerStore.isAllowed(this.groupId(msg), this.gatewayConfig);
    if (!msg.group!.addressed) {
      if (enabled) this.rememberGroupLine(msg, peerId);
      return undefined;
    }
    const command = msg.text.trim().split(/\s+/)[0].toLowerCase();
    if (command === "/enable") return this.enableGroup(msg, peerId, enabled);
    if (!enabled) {
      return `I'm not enabled in this group yet. Someone already authorized to talk to ${this.interlocutorName()} can enable me by sending /enable here.`;
    }
    if (command === "/disable") return this.disableGroup(msg, peerId);
    this.intent?.noteReply(this.conversationId(msg, peerId), this.interlocutorName());
    await this.peerStore.upsertPeer({
      channel: msg.channel,
      externalId: msg.externalId,
      displayName: msg.displayName,
      lastSeenAt: new Date().toISOString(),
    });
    this.peerStore.updatePresence(peerId, "chatting");
    return true;
  }

  private groupWelcome(): string {
    const who = this.interlocutorName();
    return [
      `Enabled: everyone in this group can now talk to ${who}.`,
      this.gatewayConfig.groupReplies === "intent"
        ? "Mention me or reply to one of my messages and I'll answer; I also join in when a message is for me, and read the rest as context."
        : "Mention me or reply to one of my messages and I'll answer; I read the rest of the conversation as context.",
      this.gatewayConfig.agent ? "" : "/agent picks who answers in this group, /polpo goes back to the orchestrator.",
      "/new starts a fresh conversation, /disable turns me off here.",
    ].filter(Boolean).join("\n");
  }

  private async enableGroup(msg: InboundMessage, peerId: string, alreadyEnabled: boolean): Promise<string> {
    if (alreadyEnabled) return `Already enabled: everyone here can talk to ${this.interlocutorName()}.`;
    // Only someone already trusted (paired in a private chat) can extend that trust to a group.
    if (!await this.personAuthorized(peerId)) {
      return "Only someone already authorized to talk to me can enable this group. Pair with me in a private chat first, then send /enable here.";
    }
    await this.activateGroup(msg.channel, msg.chatId, msg.group?.title, peerId);
    return this.groupWelcome();
  }

  private async disableGroup(msg: InboundMessage, peerId: string): Promise<string> {
    if (!await this.personAuthorized(peerId)) return "Only someone already authorized to talk to me can disable this group.";
    const id = this.groupId(msg);
    await this.peerStore.removeFromAllowlist(id);
    for (const key of this.groupContext.keys()) if (key === id || key.startsWith(`${id}:`)) this.groupContext.delete(key);
    this.log("info", `Group ${id} disabled by ${peerId}`);
    return "Disabled: I won't answer in this group until someone authorized sends /enable again.";
  }

  private async activateGroup(channel: ChannelType, chatId: string, title: string | undefined, by: string): Promise<void> {
    const id = this.groupId({ channel, chatId });
    await this.peerStore.addToAllowlist(id);
    await this.peerStore.upsertPeer({ channel, externalId: `group:${chatId}`, displayName: title, lastSeenAt: new Date().toISOString() });
    this.log("info", `Group ${id}${title ? ` ("${title}")` : ""} enabled by ${by}`);
  }

  /** The bot was added to a group: enabled at once when the person who added it is authorized. */
  async handleGroupJoined(channel: ChannelType, chatId: string, title: string | undefined, senderId: string): Promise<string | undefined> {
    if (!this.gatewayConfig.enableInbound) return undefined;
    if (await this.peerStore.isAllowed(this.groupId({ channel, chatId }), this.gatewayConfig)) return this.groupWelcome();
    const peerId = `${channel}:${senderId}`;
    if (await this.personAuthorized(peerId)) {
      await this.activateGroup(channel, chatId, title, peerId);
      return this.groupWelcome();
    }
    return `Hi! I'll answer here once someone already authorized to talk to ${this.interlocutorName()} sends /enable in this group.`;
  }

  /** A group became a supergroup: its activation follows the new chat id. */
  async handleGroupMigrated(channel: ChannelType, chatId: string, fromChatId: string, title?: string): Promise<void> {
    const from = this.groupId({ channel, chatId: fromChatId });
    if (!await this.peerStore.isAllowed(from)) return;
    await this.activateGroup(channel, chatId, title, from);
    await this.peerStore.removeFromAllowlist(from);
  }

  /** Keep an unaddressed group message for the next turn of that group conversation. */
  private rememberGroupLine(msg: InboundMessage, peerId: string): void {
    const key = this.conversationId(msg, peerId);
    const now = Date.now();
    const lines = (this.groupContext.get(key) ?? []).filter(l => now - l.at < GROUP_CONTEXT_MS);
    lines.push({ name: msg.displayName ?? msg.externalId, text: msg.text.slice(0, 1_000), at: now });
    this.groupContext.delete(key); // re-insert: Map order = least recently used first
    this.groupContext.set(key, lines.slice(-GROUP_CONTEXT_LINES));
    if (this.groupContext.size > GROUP_CONTEXT_CONVERSATIONS) {
      this.groupContext.delete(this.groupContext.keys().next().value!);
    }
  }

  /**
   * The text of a group turn: who is speaking, preceded by what the group said since the last
   * turn (those lines are consumed: from now on they are part of the session).
   */
  private groupTurnText(msg: InboundMessage, conversation: string): string {
    const now = Date.now();
    const lines = (this.groupContext.get(conversation) ?? []).filter(l => now - l.at < GROUP_CONTEXT_MS);
    this.groupContext.delete(conversation);
    const speaker = `${msg.displayName ?? msg.externalId}: ${msg.text}`;
    if (lines.length === 0) return speaker;
    return `[Earlier in the group, not addressed to you]\n${lines.map(l => `${l.name}: ${l.text}`).join("\n")}\n\n${speaker}`;
  }

  /**
   * Handle approval button callbacks (preserves existing TelegramCallbackPoller behavior).
   */
  async handleApprovalCallback(
    action: string,
    requestId: string,
    chatId: string,
    resolvedBy: string,
    /** Who pressed the button. trusted: pressed in the channel's own (owner) chat. */
    actor?: { peerId: string; trusted?: boolean; pendingKey?: string },
  ): Promise<string> {
    if (!this.approvalResolver) return "No approval resolver configured";
    // In a group anyone can press a button: only authorized people decide.
    if (actor && !actor.trusted && !await this.personAuthorized(actor.peerId)) {
      return "Only people authorized to talk to me can approve or reject.";
    }

    if (action === "approve") {
      const result = await this.approvalResolver.approve(requestId, resolvedBy);
      return result.ok ? "Approved successfully" : `Error: ${result.error}`;
    } else if (action === "reject") {
      this.pendingRevise.set(actor?.pendingKey ?? chatId, requestId);
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

  /** `conversation` keys the interlocutor and session: the person, or the group in a group. */
  private async handleCommand(msg: InboundMessage, peerId: string, conversation: string): Promise<CommandResult | undefined> {
    const parts = msg.text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Approvals and pairing stay with people authorized in a private chat, also inside groups.
    if (msg.group && ["/approve", "/reject", "/pair"].includes(cmd) && !await this.personAuthorized(peerId)) {
      return { text: "Only people authorized in a private chat with me can do this." };
    }

    switch (cmd) {
      case "/start": // Telegram sends it when the bot is added to a group from a link
        return msg.group ? await this.cmdHelp(true) : undefined;
      case "/help":
        return await this.cmdHelp(!!msg.group);
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
        return this.cmdReject(args, peerId, this.pendingKey(msg));
      case "/new":
        return this.cmdNewSession(conversation, !!msg.group);
      case "/agent":
        return this.cmdAgent(args, conversation, !!msg.group);
      case "/polpo":
        return this.cmdPolpo(conversation);
      case "/pair":
        return this.cmdPair(args, peerId);
      default:
        // Unknown command — fall through to chat
        return undefined;
    }
  }

  private async cmdHelp(inGroup = false): Promise<CommandResult> {
    if (inGroup) {
      const commands = (await this.groupMenuCommands()).map(c => `/${c.command} — ${c.description}`);
      return { text: `Mention me or reply to my messages to talk to ${this.interlocutorName()} here; I read the rest of the conversation as context.\n\n${commands.join("\n")}` };
    }
    if (this.gatewayConfig.agent) {
      const suggestions = await this.agentSuggestions();
      const lines = [
        ...suggestions.map(s => `/${s.command} — ${s.title}`),
        `/new — ${COMMANDS["/new"]}`,
      ];
      return { text: `You are talking to ${this.gatewayConfig.agent}. Write freely, or use:\n\n${lines.join("\n")}` };
    }
    const lines = Object.entries(COMMANDS)
      .filter(([cmd]) => cmd !== "/enable" && cmd !== "/disable")
      .map(([cmd, desc]) => `${cmd} — ${desc}`);
    return { text: `Available commands:\n\n${lines.join("\n")}` };
  }

  /** Suggestions of the dedicated agent, as commands. */
  private async agentSuggestions(): Promise<SuggestionCommand[]> {
    const name = this.gatewayConfig.agent;
    if (!name) return [];
    const agent = (await this.orchestrator.getAgents()).find(a => a.name === name);
    return suggestionCommands((agent as { suggestions?: { title?: string; prompt?: string }[] } | undefined)?.suggestions);
  }

  /** /<suggestion> on a dedicated bot: send the prompt, or ask for its [placeholder] first. */
  private async handleSuggestionCommand(msg: InboundMessage, conversation: string): Promise<string | GatewayReply | undefined> {
    if (!this.gatewayConfig.agent) return undefined;
    const name = msg.text.trim().split(/\s+/)[0].slice(1).replace(/@\S+$/, "").toLowerCase();
    const suggestion = (await this.agentSuggestions()).find(s => s.command === name);
    if (!suggestion) return undefined;
    if (!suggestion.placeholder) return this.handleChat({ ...msg, text: suggestion.prompt }, conversation);
    this.pendingSuggestion.set(this.pendingKey(msg), suggestion);
    return {
      text: `${suggestion.title}\n\n${suggestion.prompt.replace(PLACEHOLDER, `<${suggestion.placeholder}>`)}\n\nReply with: ${suggestion.placeholder}`,
      forceReply: { placeholder: suggestion.placeholder.slice(0, 64) },
    };
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

  private async cmdNewSession(conversation: string, inGroup = false): Promise<CommandResult> {
    const agent = await this.getActiveAgent(conversation);
    const key = await this.sessionKey(conversation, agent);
    await this.peerStore.clearSession(key);
    this.forceNewSession.add(key);
    this.groupContext.delete(conversation);
    return { text: `Session reset. ${inGroup ? "The next message here" : "Your next message"} starts a new conversation with ${agent ?? "Polpo"}.` };
  }

  private dedicatedMessage(): CommandResult {
    return { text: `This bot is dedicated to ${this.gatewayConfig.agent}. Use the main bot to talk to Polpo or other agents.` };
  }

  private async cmdAgent(args: string[], conversation: string, inGroup = false): Promise<CommandResult> {
    if (this.gatewayConfig.agent) return this.dedicatedMessage();
    const agents = await this.orchestrator.getAgents();
    if (args.length === 0) {
      const current = await this.getActiveAgent(conversation);
      const names = agents.map(a => a.name).join(", ") || "none";
      const choices: ReplyButton[] = [
        { text: `🐙 Polpo${current ? "" : " ✓"}`, data: `agent:${ORCHESTRATOR_CHOICE}` },
        ...agents.map(a => ({ text: `${a.name}${a.name === current ? " ✓" : ""}`, data: `agent:${a.name}`.slice(0, 64) })),
      ];
      const buttons: ReplyButton[][] = [];
      for (let i = 0; i < choices.length; i += 2) buttons.push(choices.slice(i, i + 2));
      return {
        text: `${inGroup ? "This group is" : "You are"} talking to ${current ?? "Polpo (orchestrator)"}.\nPick who to talk to, or send /agent NAME.\n\nAgents: ${names}`,
        buttons,
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

    await this.peerStore.setSessionId(await this.activeAgentKey(conversation), agent.name);
    return { text: `${inGroup ? "This group is" : "You are"} now talking to ${agent.name} (${agent.role}).\nSend /polpo to go back to the orchestrator.` };
  }

  private async cmdPolpo(conversation: string): Promise<CommandResult> {
    if (this.gatewayConfig.agent) return this.dedicatedMessage();
    await this.peerStore.clearSession(await this.activeAgentKey(conversation));
    return { text: "Now talking to Polpo (orchestrator)." };
  }

  /** Inline-button selection ("agent:<name>"); same rules as /agent and /polpo. */
  async handleMenuCallback(action: string, value: string, msg: Omit<InboundMessage, "text">): Promise<string | undefined> {
    if (action !== "agent" || !this.gatewayConfig.enableInbound) return undefined;
    const peerId = `${msg.channel}:${msg.externalId}`;
    // In a group the button belongs to the group (enabled = everyone may use it).
    const allowedId = msg.group ? this.groupId(msg) : peerId;
    if (!await this.peerStore.isAllowed(allowedId, this.gatewayConfig)) return undefined;
    const conversation = this.conversationId({ ...msg, text: "" }, peerId);
    const result = value === ORCHESTRATOR_CHOICE
      ? await this.cmdPolpo(conversation)
      : await this.cmdAgent([value], conversation, !!msg.group);
    return result.text;
  }

  /** Commands for the channel menu; a dedicated bot shows its agent's suggestions. */
  async menuCommands(): Promise<MenuCommand[]> {
    const pick = this.gatewayConfig.agent
      ? ["/new", "/help"]
      : ["/agent", "/polpo", "/new", "/status", "/tasks", "/missions", "/agents", "/approve", "/help"];
    const suggestions = (await this.agentSuggestions()).map(s => ({ command: s.command, description: s.title.slice(0, 256) }));
    return [...suggestions, ...pick.map(cmd => ({ command: cmd.slice(1), description: COMMANDS[cmd] }))];
  }

  /** Commands for the menu inside groups. */
  async groupMenuCommands(): Promise<MenuCommand[]> {
    const pick = this.gatewayConfig.agent
      ? ["/new", "/help", "/enable", "/disable"]
      : ["/agent", "/polpo", "/new", "/status", "/help", "/enable", "/disable"];
    const suggestions = (await this.agentSuggestions()).map(s => ({ command: s.command, description: s.title.slice(0, 256) }));
    const describe: Record<string, string> = { ...COMMANDS, "/new": "Start a fresh conversation in this group" };
    return [...suggestions, ...pick.map(cmd => ({ command: cmd.slice(1), description: describe[cmd] }))];
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
  private async resolveSessionId(peerId: string, agent: string | undefined, firstText: string, scope?: string): Promise<string> {
    const key = await this.sessionKey(peerId, agent);
    const settings = this.sessionSettings(agent);
    // A group keeps its own conversation (scoped): it never continues someone's web chat, nor the reverse.
    const sessionMode = scope ? "per-peer" : settings.sessionMode;
    const { idleMinutes } = settings;
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

    if (!sessionId) {
      const title = firstText.slice(0, 60);
      sessionId = scope ? await this.sessionStore.create(title, agent, { scope }) : await this.sessionStore.create(title, agent);
    }
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

  /**
   * Chat turn, answered on the origin channel or piped to another one: the inbound
   * message is echoed there first (unless echoInbound is false), then partials and reply.
   */
  private async handleChat(msg: InboundMessage, conversation: string): Promise<string | GatewayReply | undefined> {
    if (msg.group) msg = { ...msg, text: this.groupTurnText(msg, conversation) };
    const target = this.replyTargetFor(msg);
    if (!target || !this.replyRouter) return this.runChat(msg, conversation);
    const route = this.replyRouter;
    const deliver = (event: ReplyRouteEvent) => route(target, event).catch(err => {
      this.log("warn", `Reply route to "${target.channel}" failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    if (target.echoInbound !== false) {
      const files = (msg.attachments ?? []).map(a => `[${a.filename}]`).join(" ");
      await deliver({ kind: "echo", text: [msg.text.trim(), files].filter(Boolean).join(" "), from: msg.displayName ?? msg.externalId, via: msg.channel });
    }
    this.partialOverride.set(msg.chatId, text => deliver({ kind: "partial", text }));
    let reply: string | GatewayReply | undefined;
    try {
      reply = await this.runChat(msg, conversation);
    } finally {
      this.partialOverride.delete(msg.chatId);
    }
    const out = typeof reply === "string" ? { text: reply } : reply;
    if (out) await deliver({ kind: "reply", reply: out });
    return { text: "", deliveredTo: target.channel };
  }

  private async runChat(msg: InboundMessage, conversation: string): Promise<string | GatewayReply | undefined> {
    /** Session lease held by this gateway's own loop (one turn per session, like every turn). */
    let leased: { sessionId: string; owner: string } | undefined;
    try {
      const agent = await this.getActiveAgent(conversation);
      const attachments = msg.attachments ?? [];
      const title = msg.group
        ? `${msg.group.title ?? "Group"} (${msg.channel} group)`
        : msg.text || attachments.map(a => a.filename).join(", ");
      const sessionId = await this.resolveSessionId(conversation, agent, title, msg.group ? conversation : undefined);
      // Agents, and any turn with media, go through the host pipeline (vision + attachment storage).
      if (agent || attachments.length > 0) return await this.handleRunnerChat(msg, agent, sessionId);

      // One turn per session: wait for a web/queued answer running in this conversation.
      const owner = `channel-${nanoid(10)}`;
      if (!(await sessionLeases.acquire(sessionId, owner, { waitMs: ChannelGateway.LEASE_WAIT_MS }))) {
        return "I'm still working on the previous message in this conversation — please try again in a moment.";
      }
      leased = { sessionId, owner };

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
      const peer = msg.group ? undefined : await this.peerStore.getPeer(conversation);
      const peerContext = msg.group
        ? `\n\n## Caller context\nA ${msg.channel} group${msg.group.title ? ` ("${msg.group.title}")` : ""}: several people talk here and anyone in it may write to you. Each message starts with the speaker's name.`
        : peer
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
        const partial = this.partialOverride.get(msg.chatId)
          ?? (this.onPartialResponse ? (text: string) => this.onPartialResponse!(msg.chatId, text, this.sendTarget(msg)) : undefined);
        if (turnText.trim() && partial) {
          await partial(turnText);
          sentPartials = true;
          // Don't add to finalText since it was already sent
        } else {
          finalText += turnText;
        }

        // Send typing indicator while executing tools
        if (this.onTyping) await this.onTyping(msg.chatId, this.sendTarget(msg));

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

      // Channels split long replies into several messages; cap runaway output.
      if (finalText.length > MAX_REPLY_CHARS) {
        finalText = finalText.slice(0, MAX_REPLY_CHARS - 10) + "\n\n... (truncated)";
      }

      // If all text was already sent as partials, nothing left to return
      if (!finalText && sentPartials) return undefined;
      return finalText || "I processed your request but have nothing to say.";
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return `Sorry, I encountered an error: ${errMsg}`;
    } finally {
      if (leased) sessionLeases.release(leased.sessionId, leased.owner);
    }
  }

  /** How long a channel message waits for an answer already running in its conversation. */
  static LEASE_WAIT_MS = 10 * 60 * 1000;

  /**
   * Turn through the host's chat pipeline (agent-direct, or orchestrator when
   * agent is undefined). The pipeline persists both messages and attachments.
   */
  private async handleRunnerChat(msg: InboundMessage, agent: string | undefined, sessionId: string): Promise<string | GatewayReply> {
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

    if (this.onTyping) await this.onTyping(msg.chatId, this.sendTarget(msg));
    const { text, files = [] } = await runner({ agent, sessionId, messages });

    const body = text.trim();
    const reply = body || (files.length > 0 ? "" : `${who} processed your request but has nothing to say.`);
    const capped = reply.length > MAX_REPLY_CHARS ? reply.slice(0, MAX_REPLY_CHARS - 10) + "\n\n... (truncated)" : reply;
    return files.length > 0 ? { text: capped, files } : capped;
  }
}
