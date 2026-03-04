/**
 * WhatsApp tools — agent-level tools for reading, sending, and searching
 * WhatsApp messages via the Baileys bridge.
 *
 * Requires an active WhatsApp bridge connection (configured in polpo.json).
 * Messages are stored locally in `.polpo/whatsapp.db`.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { WhatsAppStore } from "../stores/whatsapp-store.js";

// ─── Schemas ──────────────────────────────────

const WhatsAppListSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Max chats to return (default 20)", default: 20 })),
});

const WhatsAppReadSchema = Type.Object({
  chat: Type.String({ description: "Phone number, contact name, or JID of the chat to read" }),
  limit: Type.Optional(Type.Number({ description: "Max messages to return (default 30)", default: 30 })),
});

const WhatsAppSendSchema = Type.Object({
  to: Type.String({ description: "Recipient phone number (with country code, no +), contact name, or JID" }),
  message: Type.String({ description: "Message text to send" }),
});

const WhatsAppSearchSchema = Type.Object({
  query: Type.String({ description: "Text to search for in message content" }),
  chat: Type.Optional(Type.String({ description: "Limit search to a specific chat (phone, name, or JID)" })),
  limit: Type.Optional(Type.Number({ description: "Max results (default 20)", default: 20 })),
});

const WhatsAppContactsSchema = Type.Object({
  query: Type.Optional(Type.String({ description: "Search contacts by name or phone number" })),
  limit: Type.Optional(Type.Number({ description: "Max contacts to return (default 50)", default: 50 })),
});

// ─── Helpers ──────────────────────────────────

/** Resolve a user input (phone, name, JID) to a JID. */
function resolveJid(input: string, store: WhatsAppStore): string {
  // Already a JID?
  if (input.includes("@")) return input;

  // Try contact lookup by name or phone
  const contact = store.resolveContact(input);
  if (contact) return contact.jid;

  // Assume it's a phone number — clean and make JID
  const clean = input.replace(/[+\s-]/g, "");
  return `${clean}@s.whatsapp.net`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ─── Tool Factories ───────────────────────────

interface WhatsAppToolDeps {
  store: WhatsAppStore;
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
}

function createWhatsAppListTool(deps: WhatsAppToolDeps): AgentTool<typeof WhatsAppListSchema> {
  return {
    name: "whatsapp_list",
    label: "List WhatsApp Chats",
    description: "List recent WhatsApp chats with last message preview, contact name, and unread count.",
    parameters: WhatsAppListSchema,
    async execute(_id, params) {
      const chats = deps.store.listChats(params.limit ?? 20);

      if (chats.length === 0) {
        return { content: [{ type: "text", text: "No WhatsApp chats found." }], details: {} };
      }

      const lines = chats.map((c, i) => {
        const name = c.name ? `${c.name} (${c.phone})` : c.phone;
        const preview = c.lastMessage ? c.lastMessage.slice(0, 60).replace(/\n/g, " ") : "(no messages)";
        const time = c.lastMessageAt ? formatTimestamp(c.lastMessageAt) : "";
        const unread = c.unread > 0 ? ` [${c.unread} unread]` : "";
        return `${i + 1}. ${name}${unread}\n   ${time} — ${preview}`;
      });

      return {
        content: [{ type: "text", text: `WhatsApp chats (${chats.length}):\n\n${lines.join("\n\n")}` }],
        details: { count: chats.length },
      };
    },
  };
}

function createWhatsAppReadTool(deps: WhatsAppToolDeps): AgentTool<typeof WhatsAppReadSchema> {
  return {
    name: "whatsapp_read",
    label: "Read WhatsApp Chat",
    description: "Read messages from a WhatsApp chat. Specify contact name, phone number, or JID.",
    parameters: WhatsAppReadSchema,
    async execute(_id, params) {
      const jid = resolveJid(params.chat, deps.store);
      const messages = deps.store.listMessages(jid, params.limit ?? 30);

      if (messages.length === 0) {
        return { content: [{ type: "text", text: `No messages found for ${params.chat}` }], details: {} };
      }

      // Reverse to show oldest first (chronological)
      const reversed = [...messages].reverse();

      const lines = reversed.map(m => {
        const sender = m.fromMe ? "You" : (m.senderName ?? m.senderJid.replace(/@.*/, ""));
        const time = formatTimestamp(m.timestamp);
        const media = m.mediaType ? ` [${m.mediaType}]` : "";
        return `[${time}] ${sender}${media}: ${m.text}`;
      });

      const contact = deps.store.resolveContact(params.chat);
      const header = contact ? `${contact.name} (${contact.phone})` : params.chat;

      return {
        content: [{ type: "text", text: `Messages with ${header} (${messages.length}):\n\n${lines.join("\n")}` }],
        details: { count: messages.length, chatJid: jid },
      };
    },
  };
}

function createWhatsAppSendTool(deps: WhatsAppToolDeps): AgentTool<typeof WhatsAppSendSchema> {
  return {
    name: "whatsapp_send",
    label: "Send WhatsApp Message",
    description: "Send a WhatsApp message to a phone number or contact name.",
    parameters: WhatsAppSendSchema,
    async execute(_id, params) {
      const jid = resolveJid(params.to, deps.store);

      try {
        const msgId = await deps.sendMessage(jid, params.message);

        // Store outbound message
        if (msgId) {
          deps.store.appendMessage({
            id: msgId,
            chatJid: jid,
            senderJid: "me",
            text: params.message,
            fromMe: true,
            timestamp: Math.floor(Date.now() / 1000),
          });
        }

        const contact = deps.store.resolveContact(params.to);
        const recipient = contact ? `${contact.name} (${contact.phone})` : params.to;

        return {
          content: [{ type: "text", text: `Message sent to ${recipient}.` }],
          details: { jid, messageId: msgId },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to send WhatsApp message: ${msg}` }], details: { error: msg } };
      }
    },
  };
}

function createWhatsAppSearchTool(deps: WhatsAppToolDeps): AgentTool<typeof WhatsAppSearchSchema> {
  return {
    name: "whatsapp_search",
    label: "Search WhatsApp Messages",
    description: "Search WhatsApp messages by text content. Optionally limit to a specific chat.",
    parameters: WhatsAppSearchSchema,
    async execute(_id, params) {
      const chatJid = params.chat ? resolveJid(params.chat, deps.store) : undefined;
      const results = deps.store.searchMessages(params.query, params.limit ?? 20, chatJid);

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No messages found matching "${params.query}"` }], details: {} };
      }

      const lines = results.map(m => {
        const sender = m.fromMe ? "You" : (m.senderName ?? m.senderJid.replace(/@.*/, ""));
        const time = formatTimestamp(m.timestamp);
        const chat = m.chatJid.replace(/@.*/, "");
        return `[${time}] ${chat} — ${sender}: ${m.text.slice(0, 120)}`;
      });

      return {
        content: [{ type: "text", text: `Search results for "${params.query}" (${results.length}):\n\n${lines.join("\n")}` }],
        details: { count: results.length },
      };
    },
  };
}

function createWhatsAppContactsTool(deps: WhatsAppToolDeps): AgentTool<typeof WhatsAppContactsSchema> {
  return {
    name: "whatsapp_contacts",
    label: "WhatsApp Contacts",
    description: "List or search WhatsApp contacts. Shows name, phone number, and last seen time.",
    parameters: WhatsAppContactsSchema,
    async execute(_id, params) {
      const contacts = params.query
        ? deps.store.searchContacts(params.query, params.limit ?? 50)
        : deps.store.listContacts(params.limit ?? 50);

      if (contacts.length === 0) {
        const qualifier = params.query ? ` matching "${params.query}"` : "";
        return { content: [{ type: "text", text: `No contacts found${qualifier}.` }], details: {} };
      }

      const lines = contacts.map((c, i) => {
        const lastSeen = formatTimestamp(c.lastSeen);
        return `${i + 1}. ${c.name} — +${c.phone} (last seen: ${lastSeen})`;
      });

      return {
        content: [{ type: "text", text: `WhatsApp contacts (${contacts.length}):\n\n${lines.join("\n")}` }],
        details: { count: contacts.length },
      };
    },
  };
}

// ─── Public API ───────────────────────────────

export type WhatsAppToolName =
  | "whatsapp_list"
  | "whatsapp_read"
  | "whatsapp_send"
  | "whatsapp_search"
  | "whatsapp_contacts";

export const ALL_WHATSAPP_TOOL_NAMES: WhatsAppToolName[] = [
  "whatsapp_list",
  "whatsapp_read",
  "whatsapp_send",
  "whatsapp_search",
  "whatsapp_contacts",
];

export function createWhatsAppTools(
  deps: WhatsAppToolDeps,
  allowedTools?: string[],
): AgentTool<any>[] {
  const factories: Record<WhatsAppToolName, () => AgentTool<any>> = {
    whatsapp_list: () => createWhatsAppListTool(deps),
    whatsapp_read: () => createWhatsAppReadTool(deps),
    whatsapp_send: () => createWhatsAppSendTool(deps),
    whatsapp_search: () => createWhatsAppSearchTool(deps),
    whatsapp_contacts: () => createWhatsAppContactsTool(deps),
  };

  const names = allowedTools
    ? ALL_WHATSAPP_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_WHATSAPP_TOOL_NAMES;

  return names.map(n => factories[n]());
}
