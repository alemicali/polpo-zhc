/**
 * WhatsApp message + contact store — SQLite-backed persistence for messages
 * received/sent via Baileys, and a contact directory resolved from pushNames.
 *
 * Stored in `.polpo/whatsapp.db`.
 */

import { createRequire } from "node:module";

/** Minimal interface covering better-sqlite3 / bun:sqlite API surface */
interface PolpoDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): { changes: number }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  close(): void;
}

function createDatabase(dbPath: string): PolpoDatabase {
  if (typeof process !== "undefined" && (process.versions as any)?.bun) {
    const { Database } = require("bun:sqlite");
    return new Database(dbPath, { strict: true });
  }
  const req = createRequire(import.meta.url);
  const Database = req("better-sqlite3");
  return new Database(dbPath);
}

// ─── Types ──────────────────────────────────────

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

// ─── Store ──────────────────────────────────────

export class WhatsAppStore {
  private db: PolpoDatabase;

  constructor(dbPath: string) {
    this.db = createDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        sender_jid TEXT NOT NULL,
        sender_name TEXT,
        text TEXT NOT NULL,
        from_me INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL,
        media_type TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_jid, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp DESC);

      CREATE TABLE IF NOT EXISTS contacts (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        last_seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    `);
  }

  // ── Messages ──

  /** Insert a message (idempotent — ignores duplicates by ID). */
  appendMessage(msg: WhatsAppMessage): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO messages (id, chat_jid, sender_jid, sender_name, text, from_me, timestamp, media_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(msg.id, msg.chatJid, msg.senderJid, msg.senderName ?? null, msg.text, msg.fromMe ? 1 : 0, msg.timestamp, msg.mediaType ?? null);
  }

  /** List messages in a chat, newest first. */
  listMessages(chatJid: string, limit = 50, before?: number): WhatsAppMessage[] {
    const sql = before
      ? `SELECT * FROM messages WHERE chat_jid = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`
      : `SELECT * FROM messages WHERE chat_jid = ? ORDER BY timestamp DESC LIMIT ?`;
    const params = before ? [chatJid, before, limit] : [chatJid, limit];
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(rowToMessage);
  }

  /** Search messages across all chats by text content. */
  searchMessages(query: string, limit = 30, chatJid?: string): WhatsAppMessage[] {
    const pattern = `%${query}%`;
    const sql = chatJid
      ? `SELECT * FROM messages WHERE chat_jid = ? AND text LIKE ? ORDER BY timestamp DESC LIMIT ?`
      : `SELECT * FROM messages WHERE text LIKE ? ORDER BY timestamp DESC LIMIT ?`;
    const params = chatJid ? [chatJid, pattern, limit] : [pattern, limit];
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(rowToMessage);
  }

  /** List recent chats with last message preview. */
  listChats(limit = 30): WhatsAppChat[] {
    const rows = this.db.prepare(`
      SELECT 
        m.chat_jid,
        c.name AS contact_name,
        MAX(m.timestamp) AS last_ts,
        COUNT(*) AS msg_count,
        (SELECT text FROM messages m2 WHERE m2.chat_jid = m.chat_jid ORDER BY m2.timestamp DESC LIMIT 1) AS last_text,
        (SELECT COUNT(*) FROM messages m3 
         WHERE m3.chat_jid = m.chat_jid AND m3.from_me = 0 
         AND m3.timestamp > COALESCE(
           (SELECT MAX(m4.timestamp) FROM messages m4 WHERE m4.chat_jid = m.chat_jid AND m4.from_me = 1), 0
         )
        ) AS unread_count
      FROM messages m
      LEFT JOIN contacts c ON c.jid = m.chat_jid
      GROUP BY m.chat_jid
      ORDER BY last_ts DESC
      LIMIT ?
    `).all(limit) as any[];

    return rows.map(r => ({
      jid: r.chat_jid,
      name: r.contact_name ?? undefined,
      phone: jidToPhone(r.chat_jid),
      isGroup: String(r.chat_jid).endsWith("@g.us"),
      lastMessage: r.last_text ?? undefined,
      lastMessageAt: r.last_ts ?? undefined,
      messageCount: r.msg_count ?? 0,
      unread: r.unread_count ?? 0,
    }));
  }

  // ── Contacts ──

  /** Upsert a contact (updates name and lastSeen if newer). */
  upsertContact(jid: string, name: string, timestamp?: number): void {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO contacts (jid, name, phone, last_seen)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = CASE WHEN excluded.last_seen >= contacts.last_seen THEN excluded.name ELSE contacts.name END,
        last_seen = MAX(contacts.last_seen, excluded.last_seen)
    `).run(jid, name, jidToPhone(jid), ts);
  }

  /** List all contacts, most recently seen first. */
  listContacts(limit = 100): WhatsAppContact[] {
    const rows = this.db.prepare(
      `SELECT * FROM contacts ORDER BY last_seen DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(rowToContact);
  }

  /** Search contacts by name or phone. */
  searchContacts(query: string, limit = 20): WhatsAppContact[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? ORDER BY last_seen DESC LIMIT ?`
    ).all(pattern, pattern, limit) as any[];
    return rows.map(rowToContact);
  }

  /** Resolve a name or phone to a JID. Returns first match or undefined. */
  resolveContact(nameOrPhone: string): WhatsAppContact | undefined {
    // Try exact phone match first
    const clean = nameOrPhone.replace(/[+\s-]/g, "");
    let row = this.db.prepare(
      `SELECT * FROM contacts WHERE phone = ? LIMIT 1`
    ).get(clean) as any;
    if (row) return rowToContact(row);

    // Try name match (case-insensitive)
    row = this.db.prepare(
      `SELECT * FROM contacts WHERE name LIKE ? LIMIT 1`
    ).get(`%${nameOrPhone}%`) as any;
    if (row) return rowToContact(row);

    return undefined;
  }

  /** Get total message count. */
  messageCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM messages`).get() as any;
    return row?.cnt ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ──────────────────────────────────

function jidToPhone(jid: string): string {
  return jid.replace(/@.*$/, "").replace(/:.*$/, "");
}

function rowToMessage(r: any): WhatsAppMessage {
  return {
    id: r.id,
    chatJid: r.chat_jid,
    senderJid: r.sender_jid,
    senderName: r.sender_name ?? undefined,
    text: r.text,
    fromMe: !!r.from_me,
    timestamp: r.timestamp,
    mediaType: r.media_type ?? undefined,
  };
}

function rowToContact(r: any): WhatsAppContact {
  return {
    jid: r.jid,
    name: r.name,
    phone: r.phone,
    lastSeen: r.last_seen,
  };
}
