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
 *   - Session-per-peer management (each peer gets their own conversation thread)
 *   - Slash commands (/tasks, /status, /missions, /approve, /new)
 *   - Free-text chat forwarded to POST /v1/chat/completions internally
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
import type { ApprovalCallbackResolver } from "./channels/telegram.js";
import type {
  ChannelGatewayConfig,
  ChannelType,
  NotificationChannelConfig,
} from "../core/types.js";
import { resolveModel, resolveApiKeyAsync, resolveModelSpec, buildStreamOpts } from "../llm/pi-client.js";
import { buildChatSystemPrompt } from "../llm/prompts.js";
import { streamSimple, type Message } from "@mariozechner/pi-ai";
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
}

interface CommandResult {
  text: string;
  parseMode?: "HTML" | "Markdown";
}

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
    const agents = this.orchestrator.getAgents();
    const state = await this.orchestrator.getStore().getState();
    const processes = state?.processes ?? [];

    const presenceList = await this.peerStore.getPresence();

    return {
      text: [
        `Org: ${this.orchestrator.getConfig()?.org ?? "unknown"}`,
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
    const agents = this.orchestrator.getAgents();
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
    await this.peerStore.clearSession(peerId);
    return { text: "Session reset. Your next message starts a new conversation." };
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
      // Get or create session
      let sessionId = await this.peerStore.getSessionId(peerId);

      // Check idle timeout
      if (sessionId) {
        const session = await this.sessionStore.getSession(sessionId);
        if (session) {
          const idleMinutes = this.gatewayConfig.sessionIdleMinutes ?? 60;
          const idleMs = Date.now() - new Date(session.updatedAt).getTime();
          if (idleMs > idleMinutes * 60 * 1000) {
            // Session expired — create new one
            sessionId = undefined;
          }
        }
      }

      if (!sessionId) {
        sessionId = await this.sessionStore.create(msg.text.slice(0, 60));
        await this.peerStore.setSessionId(peerId, sessionId);
      }

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
      const apiKey = await resolveApiKeyAsync(m.provider as string);
      const streamOpts = buildStreamOpts(apiKey, settings?.reasoning, m.maxTokens);

      // Run the agentic loop (non-streaming for messaging)
      const MAX_TURNS = 15;
      const messages: Message[] = [...piMessages];
      let finalText = "";
      let sentPartials = false;



      for (let turn = 0; turn < MAX_TURNS; turn++) {
        this.log("verbose", `Turn ${turn + 1}: sending ${messages.length} messages`);
        const piStream = streamSimple(m, {
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
}
