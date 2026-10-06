/** Messages and contacts seen by the WhatsApp channel, for the whatsapp_* agent tools. */

export interface WhatsAppMessage {
  id: string;
  /** JID of the chat (individual or group). */
  chatJid: string;
  /** JID of the sender (same as chatJid for 1:1). */
  senderJid: string;
  /** Display name of the sender (pushName). */
  senderName?: string;
  /** Message text content. */
  text: string;
  /** Whether we sent this message (outbound). */
  fromMe: boolean;
  /** Unix timestamp (seconds). */
  timestamp: number;
  /** Optional media type (image, video, document, audio). */
  mediaType?: string;
  /** Local downloaded media path, when available. */
  mediaPath?: string;
  /** Original media MIME type. */
  mimeType?: string;
  /** Original media filename, when available. */
  fileName?: string;
  /** Media size in bytes, when known. */
  mediaSize?: number;
  /** Local read receipt timestamp. */
  readAt?: number;
}

export interface WhatsAppContact {
  /** JID (e.g. "393387172954@s.whatsapp.net"). */
  jid: string;
  /** Display name (pushName from WhatsApp). */
  name: string;
  /** Phone number extracted from JID. */
  phone: string;
  /** Last time we saw a message from/to this contact. */
  lastSeen: number;
}

export interface WhatsAppChat {
  /** Chat JID. */
  jid: string;
  /** Contact name (if known). */
  name?: string;
  /** Phone number. */
  phone: string;
  /** Is this a group chat? */
  isGroup: boolean;
  /** Last message text (preview). */
  lastMessage?: string;
  /** Last message timestamp. */
  lastMessageAt?: number;
  /** Number of messages stored. */
  messageCount: number;
  /** Number of unread (inbound since last outbound). */
  unread: number;
}

export interface WhatsAppMessageStore {
  /** Insert a message; a known id only fills in missing details (media, sender name, read time). */
  appendMessage(msg: WhatsAppMessage): Promise<void>;
  /** Messages of a chat, newest first. */
  listMessages(chatJid: string, limit?: number, before?: number): Promise<WhatsAppMessage[]>;
  /** Text search across chats (or in one), newest first. */
  searchMessages(query: string, limit?: number, chatJid?: string): Promise<WhatsAppMessage[]>;
  /** Recent chats with last message preview and unread count. */
  listChats(limit?: number): Promise<WhatsAppChat[]>;
  /** Insert or refresh a contact (name kept from the most recent sighting). */
  upsertContact(jid: string, name: string, timestamp?: number): Promise<void>;
  listContacts(limit?: number): Promise<WhatsAppContact[]>;
  searchContacts(query: string, limit?: number): Promise<WhatsAppContact[]>;
  /** Exact phone match first, then name. */
  resolveContact(nameOrPhone: string): Promise<WhatsAppContact | undefined>;
  /** Mark messages read locally after sending read receipts; returns how many changed. */
  markRead(ids: string[], readAt?: number): Promise<number>;
  messageCount(): Promise<number>;
  close(): void;
}

/** "393331234567@s.whatsapp.net" → "393331234567". */
export function whatsappJidToPhone(jid: string): string {
  return jid.replace(/@.*$/, "").replace(/:.*$/, "");
}
