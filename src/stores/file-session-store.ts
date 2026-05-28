import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { SessionStore, Session, Message, MessageSegment, MessageRole, ToolCallInfo } from "../core/session-store.js";

/**
 * File-backed SessionStore.
 * Writes JSONL files to `.polpo/sessions/`, one per session.
 *
 * File naming: `{sessionId}.jsonl`
 * First line of each file: `{"_session":true,"id":"...","title":"...","createdAt":"..."}`
 */
export class FileSessionStore implements SessionStore {
  private readonly sessionsDir: string;
  // Header cache: `Session` summary keyed by sessionId. `listSessions()`
  // is by far the worst offender in the file store layer — each call did
  // readdir + statSync + readFile + JSON.parse per session. With ~100+
  // chat sessions that's 200+ syscalls and 5-15ms even on warm cache.
  // We hydrate once, then keep the cache surgically up-to-date.
  //
  // `messageCount` and `updatedAt` would normally drift as new messages
  // are appended via `addMessage()`. We bump both in the cache from the
  // mutators below so /chat/sessions stays correct without re-reading.
  private headerCache: Map<string, Session> | undefined;

  constructor(polpoDir: string) {
    this.sessionsDir = join(polpoDir, "sessions");
  }

  async create(title?: string, agent?: string): Promise<string> {
    if (!existsSync(this.sessionsDir)) {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
    const sessionId = nanoid(10);
    const createdAt = new Date().toISOString();
    const header: Record<string, unknown> = {
      _session: true,
      id: sessionId,
      title,
      createdAt,
    };
    if (agent) header.agent = agent;
    try {
      appendFileSync(this.sessionFile(sessionId), JSON.stringify(header) + "\n", "utf-8");
    } catch { /* best-effort: non-critical */
    }
    // Mirror into cache so the next listSessions/getSession sees it
    // without a stat. We only seed if the cache has been hydrated;
    // otherwise the first hydration will pick it up from disk.
    if (this.headerCache) {
      this.headerCache.set(sessionId, {
        id: sessionId,
        title,
        createdAt,
        updatedAt: createdAt,
        messageCount: 0,
        ...(agent ? { agent } : {}),
      });
    }
    return sessionId;
  }

  async addMessage(sessionId: string, role: MessageRole, content: string, toolCalls?: ToolCallInfo[], segments?: MessageSegment[]): Promise<Message> {
    const message: Message = {
      id: nanoid(10),
      role,
      content,
      ts: new Date().toISOString(),
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(segments && segments.length > 0 ? { segments } : {}),
    };
    try {
      const line = JSON.stringify(message);
      appendFileSync(this.sessionFile(sessionId), line + "\n", "utf-8");
    } catch { /* best-effort: non-critical */
    }
    // Bump messageCount + updatedAt so the sidebar's "recent" ordering
    // and message-count badges stay correct without re-statting the file.
    if (this.headerCache) {
      const cached = this.headerCache.get(sessionId);
      if (cached) {
        this.headerCache.set(sessionId, {
          ...cached,
          messageCount: cached.messageCount + 1,
          updatedAt: message.ts,
        });
      }
    }
    return message;
  }

  async updateMessage(sessionId: string, messageId: string, content: string, toolCalls?: ToolCallInfo[], segments?: MessageSegment[]): Promise<boolean> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return false;
    try {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      let found = false;
      const updated = lines.map((line) => {
        const obj = JSON.parse(line);
        if (!obj._session && obj.id === messageId) {
          found = true;
          const patched: Record<string, unknown> = { ...obj, content };
          if (toolCalls && toolCalls.length > 0) {
            patched.toolCalls = toolCalls;
          }
          if (segments && segments.length > 0) {
            patched.segments = segments;
          }
          return JSON.stringify(patched);
        }
        return line;
      });
      if (!found) return false;
      writeFileSync(file, updated.join("\n") + "\n", "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      const messages: Message[] = [];
      for (const line of lines) {
        const obj = JSON.parse(line);
        // Skip session header
        if (obj._session) continue;
        messages.push(obj as Message);
      }
      return messages;
    } catch { /* unreadable session file */
      return [];
    }
  }

  async getRecentMessages(sessionId: string, limit: number): Promise<Message[]> {
    const messages = await this.getMessages(sessionId);
    return messages.slice(-limit);
  }

  /** Bulk-hydrate the header cache by scanning the sessions directory. */
  private hydrateHeaderCache(): Map<string, Session> {
    if (this.headerCache) return this.headerCache;
    const cache = new Map<string, Session>();
    if (!existsSync(this.sessionsDir)) {
      this.headerCache = cache;
      return cache;
    }
    const files = readdirSync(this.sessionsDir).filter(f => f.endsWith(".jsonl"));
    for (const file of files) {
      const filePath = join(this.sessionsDir, file);
      try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        if (lines.length === 0) continue;
        const header = JSON.parse(lines[0]);
        const messageCount = lines.length - 1;
        const updatedAt = new Date(statSync(filePath).mtimeMs).toISOString();
        const id = header.id ?? file.replace(".jsonl", "");
        cache.set(id, {
          id,
          title: header.title,
          createdAt: header.createdAt ?? updatedAt,
          updatedAt,
          messageCount,
          ...(header.agent ? { agent: header.agent } : {}),
          ...(header.starred ? { starred: true } : {}),
        });
      } catch { /* skip corrupt file */ }
    }
    this.headerCache = cache;
    return cache;
  }

  async listSessions(): Promise<Session[]> {
    const cache = this.hydrateHeaderCache();
    // Mtime-ordered (most recent first) for the sidebar.
    return Array.from(cache.values()).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async getSession(sessionId: string): Promise<Session | undefined> {
    return this.hydrateHeaderCache().get(sessionId);
  }

  async getLatestSession(agent?: string | null): Promise<Session | undefined> {
    const sessions = await this.listSessions();
    if (agent === undefined) {
      // No filter — return the most recent session regardless of agent
      return sessions[0];
    }
    if (agent === null) {
      // Orchestrator sessions only (no agent)
      return sessions.find(s => !s.agent);
    }
    // Agent-specific sessions
    return sessions.find(s => s.agent === agent);
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    return this.patchHeader(sessionId, (h) => { h.title = title; });
  }

  async setStarred(sessionId: string, starred: boolean): Promise<boolean> {
    return this.patchHeader(sessionId, (h) => {
      if (starred) h.starred = true;
      else delete h.starred;
    });
  }

  /** Mutates the JSONL header in place. Returns true if applied, false on missing/corrupt file. */
  private patchHeader(sessionId: string, mutate: (header: Record<string, unknown>) => void): boolean {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return false;
    try {
      const raw = readFileSync(file, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length === 0) return false;
      const header = JSON.parse(lines[0]);
      if (!header._session) return false;
      mutate(header);
      lines[0] = JSON.stringify(header);
      writeFileSync(file, lines.join("\n") + "\n", "utf-8");
      // Mirror header changes into the cache so the sidebar reflects
      // the new title / starred flag without a re-read.
      if (this.headerCache) {
        const cached = this.headerCache.get(sessionId);
        if (cached) {
          this.headerCache.set(sessionId, {
            ...cached,
            title: typeof header.title === "string" ? header.title : cached.title,
            starred: header.starred === true ? true : undefined,
          });
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const file = this.sessionFile(sessionId);
    if (!existsSync(file)) return false;
    try {
      unlinkSync(file);
      this.headerCache?.delete(sessionId);
      return true;
    } catch { /* file already removed */
      return false;
    }
  }

  async prune(keepSessions: number): Promise<number> {
    const sessions = await this.listSessions();
    if (sessions.length <= keepSessions) return 0;
    const toRemove = sessions.slice(keepSessions);
    let removed = 0;
    for (const s of toRemove) {
      try {
        unlinkSync(this.sessionFile(s.id));
        this.headerCache?.delete(s.id);
        removed++;
      } catch { /* file already removed */ }
    }
    return removed;
  }

  async close(): Promise<void> {
    // No resources to release for file-based store
  }

  private sessionFile(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }
}
