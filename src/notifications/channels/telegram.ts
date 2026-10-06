import { markdownToTelegramHtml, splitMarkdown } from "../telegram-format.js";
import type { NotificationChannel, Notification, OutcomeAttachment } from "../types.js";
import type { NotificationChannelConfig } from "../../core/types.js";
import { basename } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  botJoined,
  groupAddressing,
  isGroupChat,
  mediaLabel,
  topicOf,
  type InboundGroup,
  type TelegramChatType,
  type TelegramGroupEvent,
  type TelegramIdentity,
} from "../telegram-groups.js";

/**
 * Telegram notification channel — sends messages via Bot API.
 *
 * Uses HTML parse_mode (much more reliable than MarkdownV2).
 * Converts standard Markdown from templates to Telegram HTML.
 *
 * Supports outcome attachments via sendDocument/sendPhoto/sendAudio.
 * Supports inline keyboard buttons for approval workflows.
 *
 * Configuration:
 *   botToken: Telegram Bot token (from @BotFather)
 *   chatId: Chat/Group/Channel ID to send to
 */
export class TelegramChannel implements NotificationChannel {
  readonly type = "telegram";
  private botToken: string;
  private chatId: string;

  constructor(config: NotificationChannelConfig) {
    this.botToken = resolveEnvVar(config.botToken ?? "");
    this.chatId = resolveEnvVar(config.chatId ?? "");
    if (!this.botToken) throw new Error("Telegram channel requires botToken");
    if (!this.chatId) throw new Error("Telegram channel requires chatId");
  }

  getBotToken(): string { return this.botToken; }
  getChatId(): string { return this.chatId; }

  async send(notification: Notification): Promise<void> {
    const text = this.formatMessage(notification);
    const keyboard = this.buildApprovalKeyboard(notification);
    await this.sendMessage(text, keyboard);
  }

  async sendWithAttachments(notification: Notification, attachments: OutcomeAttachment[]): Promise<void> {
    const keyboard = this.buildApprovalKeyboard(notification);

    // If there's a single image attachment, send it with the text as caption + keyboard
    const imageAtt = attachments.find(a => a.content && a.mimeType?.startsWith("image/"));
    if (imageAtt && imageAtt.content && imageAtt.filePath) {
      const caption = this.formatMessage(notification);
      // Telegram caption limit is 1024 chars
      const truncatedCaption = caption.length > 1000
        ? caption.slice(0, 1000) + "..."
        : caption;
      await this.sendPhotoWithKeyboard(imageAtt, truncatedCaption, keyboard);

      // Send remaining non-image attachments
      for (const att of attachments) {
        if (att === imageAtt) continue;
        try {
          if (att.content && att.filePath) {
            await this.sendFile(att);
          } else if (att.text) {
            const truncated = att.text.length > 3800
              ? att.text.slice(0, 3800) + "\n\n... (truncated)"
              : att.text;
            const label = escapeHtml(att.label);
            await this.sendMessage(`<b>${label}</b>\n\n<pre>${escapeHtml(truncated)}</pre>`);
          }
        } catch {
          // Best-effort
        }
      }
      return;
    }

    // No image attachment — send text message with keyboard, then attachments
    const text = this.formatMessage(notification);
    await this.sendMessage(text, keyboard);

    for (const att of attachments) {
      try {
        if (att.content && att.filePath) {
          await this.sendFile(att);
        } else if (att.text) {
          const truncated = att.text.length > 3800
            ? att.text.slice(0, 3800) + "\n\n... (truncated)"
            : att.text;
          const label = escapeHtml(att.label);
          await this.sendMessage(`<b>${label}</b>\n\n<pre>${escapeHtml(truncated)}</pre>`);
        }
      } catch {
        // Best-effort
      }
    }
  }

  async test(): Promise<boolean> {
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getMe`;
      const response = await fetch(url);
      return response.ok;
    } catch {
      return false;
    }
  }

  // ─── Private helpers ─────────────────────

  /**
   * Build inline keyboard for approval notifications.
   * Only applies to approval:requested events — detected via the notification metadata.
   */
  private buildApprovalKeyboard(notification: Notification): InlineKeyboard | undefined {
    // Check if this is an approval notification by looking at sourceEvent
    if (notification.sourceEvent !== "approval:requested") return undefined;

    // Extract requestId from the event payload
    const data = notification.sourceData as Record<string, unknown> | undefined;
    const requestId = data?.requestId as string | undefined;
    if (!requestId) return undefined;

    return {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${requestId}` },
          { text: "❌ Reject", callback_data: `reject:${requestId}` },
        ],
      ],
    };
  }

  private formatMessage(notification: Notification): string {
    const severityEmoji: Record<string, string> = {
      info: "ℹ️",
      warning: "⚠️",
      critical: "🚨",
    };

    const emoji = severityEmoji[notification.severity] ?? "ℹ️";
    const title = escapeHtml(notification.title);
    const body = markdownToHtml(notification.body);
    const event = escapeHtml(notification.sourceEvent);

    return [
      `${emoji} <b>${title}</b>`,
      "",
      body,
      "",
      `<i>${event}</i>`,
    ].join("\n");
  }

  private async sendMessage(text: string, replyMarkup?: InlineKeyboard): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram API failed: ${response.status} — ${respBody}`);
    }
  }

  /**
   * Send a photo with caption and optional inline keyboard.
   */
  private async sendPhotoWithKeyboard(
    att: OutcomeAttachment,
    caption: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    const filename = att.filePath ? basename(att.filePath) : "photo.png";
    const blob = new Blob([att.content! as BlobPart], { type: att.mimeType ?? "image/png" });

    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append("photo", blob, filename);
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
    if (keyboard) {
      form.append("reply_markup", JSON.stringify(keyboard));
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendPhoto`;
    const response = await fetch(url, { method: "POST", body: form });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram sendPhoto failed: ${response.status} — ${respBody}`);
    }
  }

  /**
   * Send a file attachment via Telegram Bot API.
   */
  private async sendFile(att: OutcomeAttachment): Promise<void> {
    const mime = att.mimeType ?? "";
    let method: string;
    let fileField: string;

    if (mime.startsWith("image/")) {
      method = "sendPhoto";
      fileField = "photo";
    } else if (mime.startsWith("audio/")) {
      method = "sendAudio";
      fileField = "audio";
    } else {
      method = "sendDocument";
      fileField = "document";
    }

    const filename = att.filePath ? basename(att.filePath) : "attachment";
    const blob = new Blob([att.content! as BlobPart], { type: mime || "application/octet-stream" });

    const form = new FormData();
    form.append("chat_id", this.chatId);
    form.append(fileField, blob, filename);
    form.append("caption", att.label);

    const url = `https://api.telegram.org/bot${this.botToken}/${method}`;
    const response = await fetch(url, { method: "POST", body: form });

    if (!response.ok) {
      const respBody = await response.text();
      throw new Error(`Telegram ${method} failed: ${response.status} — ${respBody}`);
    }
  }
}

// ─── Telegram Inline Keyboard types ────────

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

// ─── Telegram Callback Poller ──────────────

/**
 * Polls Telegram Bot API for callback_query updates (inline button presses).
 * Routes approval actions to the provided resolver callback.
 *
 * Supports three actions:
 *   - approve:REQUEST_ID → approves the request
 *   - reject:REQUEST_ID  → rejects the request
 *   - revise:REQUEST_ID  → prompts for feedback, then revises
 *
 * For revise: after the user presses the button, the bot asks for feedback
 * via a reply. The next text message from the same chat is used as feedback.
 */
export class TelegramCallbackPoller {
  private botToken: string;
  private chatId: string;
  private offset = 0;
  private timer?: ReturnType<typeof setInterval>;
  private pendingRevise = new Map<string, string>(); // chatId → requestId (waiting for feedback text)
  private resolver?: ApprovalCallbackResolver;
  private gateway?: TelegramGatewayHandler;
  private menuCommands?: { command: string; description: string }[];
  private groupMenuCommands?: { command: string; description: string }[];
  private identity?: TelegramIdentity;
  private identityCheckedAt = 0;
  private polling = false;
  /** Updates of one chat run in order; different chats do not wait for each other. */
  private chatQueues = new Map<string, Promise<void>>();

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  setResolver(resolver: ApprovalCallbackResolver): void {
    this.resolver = resolver;
  }

  /** Attach a ChannelGateway handler for full inbound message routing.
   *  When set, non-approval messages are forwarded to the gateway instead of being ignored. */
  setGateway(handler: TelegramGatewayHandler): void {
    this.gateway = handler;
  }

  /**
   * Commands shown in the bot's menu; registered with setMyCommands when polling starts.
   * Groups get their own list when given (commands that make sense in a shared chat).
   */
  setMenuCommands(commands: { command: string; description: string }[], groupCommands?: { command: string; description: string }[]): void {
    this.menuCommands = commands;
    this.groupMenuCommands = groupCommands;
    if (this.timer) void this.registerMenuCommands(); // already polling: register now
  }

  private async registerMenuCommands(): Promise<void> {
    if (!this.menuCommands) return;
    const lists: { commands: { command: string; description: string }[]; scope?: { type: string } }[] = [{ commands: this.menuCommands }];
    if (this.groupMenuCommands) lists.push({ commands: this.groupMenuCommands, scope: { type: "all_group_chats" } });
    for (const body of lists) {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch((err) => { console.error(`[polpo/telegram] setMyCommands failed: ${err}`); return undefined; });
      if (res && !res.ok) console.error(`[polpo/telegram] setMyCommands failed (${res.status})`);
    }
  }

  /** The bot's own id and username (getMe): needed to tell which group messages are for it. */
  async getIdentity(): Promise<TelegramIdentity | undefined> {
    if (this.identity || Date.now() - this.identityCheckedAt < 30_000) return this.identity;
    this.identityCheckedAt = Date.now();
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/getMe`);
      const body = await res.json() as { ok?: boolean; result?: { id: number; username?: string; can_read_all_group_messages?: boolean } };
      if (body.ok && body.result) {
        this.identity = { id: body.result.id, username: body.result.username, canReadAllGroupMessages: body.result.can_read_all_group_messages };
      }
    } catch { /* retried on a later group message */ }
    return this.identity;
  }

  start(intervalMs = 2000): void {
    if (this.timer) return;
    void this.registerMenuCommands();
    void this.getIdentity();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    // A slow request must not let the next tick fetch the same updates again.
    if (this.polling) return;
    this.polling = true;
    try {
      const url = `https://api.telegram.org/bot${this.botToken}/getUpdates`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offset: this.offset,
          timeout: 1,
          allowed_updates: ["callback_query", "message"],
        }),
      });

      if (!response.ok) return;

      const data = await response.json() as TelegramUpdateResponse;
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        this.offset = Math.max(this.offset, update.update_id + 1);

        const query = update.callback_query;
        const msg = update.message;
        if (query) {
          this.enqueue(String(query.message?.chat?.id ?? this.chatId), () => this.handleCallback(query));
        } else if (msg) {
          // Message text is not logged: in groups it is other people's conversation.
          const msgKeys = Object.keys(msg).filter(k => !["message_id", "chat", "from", "date", "text", "entities"].includes(k));
          console.error(`[polpo/telegram] update ${update.update_id}: ${msg.chat.type ?? "chat"}${msgKeys.length ? ` keys=[${msgKeys.join(",")}]` : ""}`);
          this.enqueue(String(msg.chat.id), () => this.handleMessage(msg));
        }
      }
    } catch (err) {
      console.error(`[polpo/telegram] Poll error: ${err instanceof Error ? err.stack : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  /** Run `work` after the earlier updates of the same chat. */
  private enqueue(chatKey: string, work: () => Promise<void>): void {
    const next = (this.chatQueues.get(chatKey) ?? Promise.resolve())
      .then(work)
      .catch((err) => console.error(`[polpo/telegram] Update error: ${err instanceof Error ? err.stack : String(err)}`));
    this.chatQueues.set(chatKey, next);
    void next.finally(() => { if (this.chatQueues.get(chatKey) === next) this.chatQueues.delete(chatKey); });
  }

  private async handleCallback(query: TelegramCallbackQuery): Promise<void> {
    if (!query.data) return;

    const [action, requestId] = query.data.split(":", 2);
    if (!action || !requestId) return;

    // Answer the callback query first (removes loading spinner)
    await this.answerCallback(query.id);

    const chatId = String(query.message?.chat?.id ?? this.chatId);
    const senderId = String(query.from?.id ?? query.message?.chat?.id ?? this.chatId);
    const senderName = query.from?.first_name;
    const group: InboundGroup | undefined = query.message && isGroupChat(query.message.chat)
      ? { title: query.message.chat.title, threadId: topicOf(query.message), addressed: true }
      : undefined;
    const target: TelegramSendTarget | undefined = group ? { threadId: group.threadId } : undefined;

    // Menu buttons (e.g. agent picker) are not approvals
    if (action === "agent") {
      const reply = await this.gateway?.handleMenuCallback?.(action, requestId, chatId, senderId, senderName, group);
      if (reply) await this.sendMarkdown(chatId, reply, undefined, undefined, target);
      return;
    }

    // If gateway is available, route through it for identity tracking
    if (this.gateway) {
      // The configured chat is the owner's: buttons pressed there are trusted without pairing.
      const response = await this.gateway.handleApprovalCallback(
        action, requestId, chatId, senderId, senderName, { trusted: senderId === this.chatId, group },
      );
      if (response) await this.sendMarkdown(chatId, response, undefined, undefined, target);
      return;
    }

    // Fallback: original approval-only logic
    if (!this.resolver) return;

    if (action === "approve") {
      const result = await this.resolver.approve(requestId, "telegram-user");
      const msg = result.ok
        ? "✅ Approved successfully"
        : `❌ Error: ${result.error}`;
      await this.sendReply(chatId, msg);
    } else if (action === "reject") {
      this.pendingRevise.set(chatId, requestId);
      await this.sendForceReply(chatId,
        "❌ <b>Rejected — tell the agent why</b>\n\nReply with your feedback. The task will be re-executed with your notes.",
      );
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chat.id);
    const senderId = String(message.from?.id ?? message.chat.id);
    const senderName = message.from?.first_name;

    const text = message.text ?? message.caption;

    // ── Gateway mode: route ALL messages (text and media) through the ChannelGateway ──
    if (this.gateway) {
      if (isGroupChat(message.chat)) return this.handleGroupMessage(message);
      const media = inboundMediaOf(message);
      if (!text && media.length === 0) return; // stickers, locations, … carry nothing usable
      await this.respond(chatId, undefined, text ?? "", media, senderId, senderName, String(message.message_id));
      return;
    }

    // ── Legacy mode: only handle pending rejection feedback ──
    if (!text || !this.resolver) return;

    const requestId = this.pendingRevise.get(chatId);
    if (!requestId) return;

    this.pendingRevise.delete(chatId);

    const result = await this.resolver.reject(requestId, text, "telegram-user");
    const msg = result.ok
      ? `❌ Rejected — task will retry with your feedback:\n<i>${escapeHtml(text)}</i>`
      : `❌ Error: ${result.error}`;
    await this.sendReply(chatId, msg);
  }

  /**
   * A message in a group or supergroup. Only messages addressed to the bot get an answer;
   * the rest reaches the gateway as context (text only, nothing is downloaded).
   */
  private async handleGroupMessage(message: TelegramMessage): Promise<void> {
    const gateway = this.gateway!;
    const chatId = String(message.chat.id);
    const title = message.chat.title;
    const threadId = topicOf(message);

    // A group upgraded to supergroup gets a new id: carry its activation over.
    if (message.migrate_from_chat_id) {
      await gateway.handleGroupEvent?.({ kind: "migrated", chatId, fromChatId: String(message.migrate_from_chat_id), title });
      return;
    }

    // Other bots and the group's linked channel are not part of the conversation; anonymous admins are.
    const anonymousAdmin = !!message.sender_chat && message.sender_chat.id === message.chat.id;
    if (!anonymousAdmin && (message.sender_chat || message.from?.is_bot)) return;
    const senderId = anonymousAdmin ? `admin${chatId}` : String(message.from?.id ?? "");
    if (!senderId) return;
    const senderName = anonymousAdmin
      ? "Group admin"
      : [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || message.from?.username;

    const me = await this.getIdentity();
    if (botJoined(message, me)) {
      const reply = await gateway.handleGroupEvent?.({ kind: "joined", chatId, title, senderId, senderName });
      if (reply) await this.sendMarkdown(chatId, reply, undefined, undefined, { threadId });
      return;
    }

    const { addressed, forOtherBot, text } = groupAddressing(message, me);
    if (forOtherBot) return;
    const group: InboundGroup = { title, threadId, addressed };
    if (!addressed) {
      const line = [mediaLabel(message), text].filter(Boolean).join(" ").trim();
      if (line) await gateway.handleInboundMessage(senderId, chatId, line, senderName, String(message.message_id), [], group);
      return;
    }
    const media = inboundMediaOf(message);
    // A bare mention ("@bot") is still a call: pass it on as written.
    const body = text.trim() || (media.length === 0 ? (message.text ?? message.caption ?? "") : "");
    if (!body && media.length === 0) return;
    await this.respond(chatId, { threadId, replyTo: message.message_id }, body, media, senderId, senderName, String(message.message_id), group);
  }

  /** Typing while the gateway works, then the reply (text, buttons, files) in the right chat and topic. */
  private async respond(
    chatId: string,
    target: TelegramSendTarget | undefined,
    text: string,
    media: InboundMediaRef[],
    senderId: string,
    senderName: string | undefined,
    messageId: string,
    group?: InboundGroup,
  ): Promise<void> {
    const gateway = this.gateway!;
    // Send typing immediately and keep refreshing every 4s until we respond
    await this.sendChatAction(chatId, "typing", target?.threadId);
    const typingInterval = setInterval(() => {
      this.sendChatAction(chatId, "typing", target?.threadId).catch(() => {});
    }, 4000);

    try {
      const { attachments, skipped } = await this.downloadMedia(media);
      if (media.length > 0 && attachments.length === 0) {
        await this.sendReply(chatId, escapeHtml(skipped[0] ?? "Could not download the attachment."), undefined, undefined, true, target);
        return;
      }
      const response = await gateway.handleInboundMessage(senderId, chatId, text, senderName, messageId, attachments, group);
      if (typeof response === "string") await this.sendMarkdown(chatId, response, undefined, undefined, target);
      else if (response) {
        if (response.text.trim() || response.buttons || response.forceReply) {
          await this.sendMarkdown(chatId, response.text, response.buttons, response.forceReply, target);
        }
        for (const file of response.files ?? []) await this.sendDocument(chatId, file.path, file.filename, target);
      }
    } finally {
      clearInterval(typingInterval);
    }
  }

  /** Download inbound media via getFile. Oversized or failed files are reported, not thrown. */
  private async downloadMedia(media: InboundMediaRef[]): Promise<{ attachments: InboundAttachment[]; skipped: string[] }> {
    const attachments: InboundAttachment[] = [];
    const skipped: string[] = [];
    for (const ref of media) {
      if ((ref.fileSize ?? 0) > TELEGRAM_MAX_DOWNLOAD_BYTES) {
        skipped.push(`${ref.filename} is too large (Telegram bots can receive up to 20 MB).`);
        continue;
      }
      try {
        const info = await fetch(`https://api.telegram.org/bot${this.botToken}/getFile?file_id=${encodeURIComponent(ref.fileId)}`)
          .then(r => r.json()) as { ok: boolean; result?: { file_path?: string } };
        if (!info.ok || !info.result?.file_path) throw new Error("getFile failed");
        const res = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${info.result.file_path}`);
        if (!res.ok) throw new Error(`download failed (${res.status})`);
        attachments.push({ kind: ref.kind, filename: ref.filename, mimeType: ref.mimeType, data: Buffer.from(await res.arrayBuffer()) });
      } catch (err) {
        console.error(`[polpo/telegram] media download error (${ref.kind}): ${err instanceof Error ? err.message : String(err)}`);
        skipped.push(`Could not download ${ref.filename}.`);
      }
    }
    return { attachments, skipped };
  }

  private async answerCallback(callbackQueryId: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    }).catch(() => {});
  }

  /** Send typing indicator to a chat (and topic). */
  async sendTyping(chatId: string, target?: TelegramSendTarget): Promise<void> {
    await this.sendChatAction(chatId, "typing", target?.threadId);
  }

  /** Send a partial response as a separate message (for multi-turn tool loops). */
  async sendPartial(chatId: string, text: string, target?: TelegramSendTarget): Promise<void> {
    await this.sendMarkdown(chatId, text, undefined, undefined, target);
  }

  /** Upload a local file as a document; failures are reported to the chat instead of being lost. */
  async sendDocument(chatId: string, path: string, filename: string, target?: TelegramSendTarget): Promise<boolean> {
    try {
      const { readFile, stat } = await import("node:fs/promises");
      const size = (await stat(path)).size;
      if (size > TELEGRAM_MAX_UPLOAD_BYTES) {
        await this.sendReply(chatId, `${escapeHtml(filename)} is too large to send on Telegram (max 50 MB).`, undefined, undefined, true, target);
        return false;
      }
      const form = new FormData();
      form.append("chat_id", chatId);
      if (target?.threadId !== undefined) form.append("message_thread_id", String(target.threadId));
      form.append("document", new Blob([new Uint8Array(await readFile(path))]), filename);
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendDocument`, { method: "POST", body: form });
      if (res.ok) return true;
      const body = await res.json().catch(() => null) as { description?: string } | null;
      console.error(`[polpo/telegram] sendDocument rejected (${res.status}): ${body?.description ?? ""}`);
    } catch (err) {
      console.error(`[polpo/telegram] sendDocument failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.sendReply(chatId, `Could not send ${escapeHtml(filename)}.`, undefined, undefined, true, target);
    return false;
  }

  /**
   * Send Markdown as one or more HTML messages (Telegram's 4096-char limit).
   * Markup (buttons / reply prompt) goes on the last message. If Telegram
   * rejects the HTML, the chunk is resent as plain text instead of being lost.
   * In a group the first message quotes the one it answers (target.replyTo), in its topic.
   */
  async sendMarkdown(
    chatId: string,
    markdown: string,
    buttons?: { text: string; data: string }[][],
    forceReply?: { placeholder?: string },
    target?: TelegramSendTarget,
  ): Promise<void> {
    const chunks = splitMarkdown(markdown);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const where = i === 0 ? target : target && { threadId: target.threadId };
      const sent = await this.sendReply(chatId, markdownToTelegramHtml(chunks[i]), last ? buttons : undefined, last ? forceReply : undefined, true, where);
      if (!sent) {
        await this.sendReply(chatId, chunks[i], last ? buttons : undefined, last ? forceReply : undefined, false, where);
      }
    }
  }

  private async sendChatAction(chatId: string, action: "typing" | "upload_photo" | "upload_document" = "typing", threadId?: number): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendChatAction`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action, ...(threadId !== undefined ? { message_thread_id: threadId } : {}) }),
    }).catch(() => {});
  }

  /** Send one message; returns false when Telegram rejects it (e.g. invalid HTML). */
  private async sendReply(
    chatId: string,
    text: string,
    buttons?: { text: string; data: string }[][],
    forceReply?: { placeholder?: string },
    html = true,
    target?: TelegramSendTarget,
  ): Promise<boolean> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(html ? { parse_mode: "HTML" } : {}),
        ...(target?.threadId !== undefined ? { message_thread_id: target.threadId } : {}),
        ...(target?.replyTo !== undefined ? { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } } : {}),
        ...(buttons ? { reply_markup: { inline_keyboard: buttons.map(row => row.map(b => ({ text: b.text, callback_data: b.data }))) } } : {}),
        // selective: in a group, only the person being answered gets the reply prompt.
        ...(forceReply ? { reply_markup: { force_reply: true, ...(target?.replyTo !== undefined ? { selective: true } : {}), ...(forceReply.placeholder ? { input_field_placeholder: forceReply.placeholder } : {}) } } : {}),
      }),
    }).catch((err) => {
      console.error(`[polpo/telegram] sendMessage failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    });
    if (!res) return false;
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { description?: string } | null;
      console.error(`[polpo/telegram] sendMessage rejected (${res.status}): ${body?.description ?? ""}`);
      return false;
    }
    return true;
  }

  /** Send a message with ForceReply — opens the reply input automatically in the Telegram client. */
  private async sendForceReply(chatId: string, text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: "Describe what needs to change...",
        },
      }),
    }).catch(() => {});
  }
}

/**
 * Gateway handler interface — bridges TelegramCallbackPoller to ChannelGateway.
 * This decouples the Telegram polling logic from the gateway routing logic.
 */
export interface TelegramGatewayHandler {
  handleInboundMessage(
    senderId: string,
    chatId: string,
    text: string,
    senderName?: string,
    messageId?: string,
    attachments?: InboundAttachment[],
    /** Set for group messages; unaddressed ones are context only. */
    group?: InboundGroup,
  ): Promise<string | TelegramReply | undefined>;

  /** Non-approval inline buttons (e.g. "agent:<name>"). */
  handleMenuCallback?(action: string, value: string, chatId: string, senderId: string, senderName?: string, group?: InboundGroup): Promise<string | undefined>;

  handleApprovalCallback(
    action: string,
    requestId: string,
    chatId: string,
    senderId: string,
    senderName?: string,
    /** trusted: pressed in the channel's own (owner) chat. */
    opts?: { trusted?: boolean; group?: InboundGroup },
  ): Promise<string | undefined>;

  /** The bot joined a group, or a group became a supergroup. Returns a message for the group. */
  handleGroupEvent?(event: TelegramGroupEvent): Promise<string | undefined>;
}

/** Where a message goes inside a chat: a forum topic, as a reply to a message. */
export interface TelegramSendTarget {
  threadId?: number;
  replyTo?: number;
}

// ─── Types for callback resolver ───────────

export interface ApprovalCallbackResult {
  ok: boolean;
  error?: string;
}

export interface ApprovalCallbackResolver {
  approve(requestId: string, resolvedBy: string): Promise<ApprovalCallbackResult>;
  reject(requestId: string, feedback: string, resolvedBy: string): Promise<ApprovalCallbackResult>;
}

// ─── Telegram API types ────────────────────

interface TelegramUpdateResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
  message?: TelegramMessage;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
  from?: TelegramUser;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  duration?: number;
  mime_type?: string;
}

export interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type?: TelegramChatType; title?: string };
  from?: TelegramUser;
  /** Anonymous group admin (the group itself) or a linked channel. */
  sender_chat?: { id: number; title?: string };
  /** Forum topic, when is_topic_message is set. */
  message_thread_id?: number;
  is_topic_message?: boolean;
  text?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  reply_to_message?: TelegramMessage;
  /** Service message opening a forum topic. */
  forum_topic_created?: unknown;
  new_chat_members?: TelegramUser[];
  group_chat_created?: boolean;
  supergroup_chat_created?: boolean;
  /** In the new supergroup: the id the group had before. */
  migrate_from_chat_id?: number;
  sticker?: { emoji?: string };
  /** File attachment (document). */
  document?: TelegramFile & { file_name?: string };
  /** Photo sizes, smallest first. */
  photo?: TelegramFile[];
  voice?: TelegramFile;
  audio?: TelegramFile & { file_name?: string };
  video?: TelegramFile & { file_name?: string };
  video_note?: TelegramFile;
  /** Caption text (on media messages) */
  caption?: string;
}

/** Bot API getFile only serves files up to 20 MB. */
const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

// ─── Utility functions ─────────────────────

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Convert Markdown to Telegram HTML (see telegram-format.ts). */
const markdownToHtml = markdownToTelegramHtml;

function resolveEnvVar(value: string): string {
  if (value.startsWith("${") && value.endsWith("}")) {
    const envKey = value.slice(2, -1);
    return process.env[envKey] ?? "";
  }
  return value;
}

// ─── Replies with inline buttons ───────────

export interface TelegramReply {
  text: string;
  buttons?: { text: string; data: string }[][];
  forceReply?: { placeholder?: string };
  /** Local files sent as documents after the text. */
  files?: { path: string; filename: string }[];
}

/** Bot API sendDocument upload limit. */
const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// ─── Inbound media ─────────────────────────

/** A file received from a channel, downloaded and ready to attach to a chat turn. */
export interface InboundAttachment {
  kind: "photo" | "document" | "voice" | "audio" | "video";
  filename: string;
  mimeType: string;
  data: Buffer;
}

interface InboundMediaRef {
  kind: InboundAttachment["kind"];
  fileId: string;
  fileSize?: number;
  filename: string;
  mimeType: string;
}

/** Media carried by a Telegram message (largest photo size only). */
export function inboundMediaOf(message: TelegramMessage): InboundMediaRef[] {
  const refs: InboundMediaRef[] = [];
  const photo = message.photo?.[message.photo.length - 1];
  if (photo) refs.push({ kind: "photo", fileId: photo.file_id, fileSize: photo.file_size, filename: "photo.jpg", mimeType: "image/jpeg" });
  if (message.document) {
    const d = message.document;
    refs.push({ kind: "document", fileId: d.file_id, fileSize: d.file_size, filename: d.file_name ?? "file", mimeType: d.mime_type ?? "application/octet-stream" });
  }
  if (message.voice) {
    refs.push({ kind: "voice", fileId: message.voice.file_id, fileSize: message.voice.file_size, filename: "voice.ogg", mimeType: message.voice.mime_type ?? "audio/ogg" });
  }
  if (message.audio) {
    const a = message.audio;
    refs.push({ kind: "audio", fileId: a.file_id, fileSize: a.file_size, filename: a.file_name ?? "audio.mp3", mimeType: a.mime_type ?? "audio/mpeg" });
  }
  const video = message.video ?? message.video_note;
  if (video) {
    refs.push({ kind: "video", fileId: video.file_id, fileSize: video.file_size, filename: (video as { file_name?: string }).file_name ?? "video.mp4", mimeType: video.mime_type ?? "video/mp4" });
  }
  return refs;
}
