/**
 * WhatsApp Business store for instances on files: contacts, messages and processed webhook keys in
 * one JSON document (.polpo/whatsapp-business/store.json), written atomically after each change.
 * The volume is bounded by the retention (messages older than retentionDays and processed keys
 * older than 7 days are purged).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryWaBusinessStore, type WaBizContact, type WaBizMessage } from "@polpo-ai/core/whatsapp-business";

interface StoreFile {
  version: 1;
  contacts: WaBizContact[];
  messages: WaBizMessage[];
  processed: Record<string, string>;
}

export class FileWaBusinessStore extends InMemoryWaBusinessStore {
  private readonly file: string;
  private loading = false;

  constructor(polpoDir: string) {
    super();
    this.file = join(polpoDir, "whatsapp-business", "store.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    this.loading = true;
    try {
      const d = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
      for (const c of d.contacts ?? []) this.contacts.set(`${c.channel}\u0000${c.waId}`, c);
      for (const m of d.messages ?? []) this.messages.set(m.id, m);
      for (const [k, at] of Object.entries(d.processed ?? {})) this.processed.set(k, at);
    } catch {
      /* a broken file starts over (the processed keys too: a retried delivery may then be handled twice) */
    } finally {
      this.loading = false;
    }
  }

  protected override changed(): void {
    if (this.loading) return;
    mkdirSync(join(this.file, ".."), { recursive: true });
    const data: StoreFile = {
      version: 1,
      contacts: [...this.contacts.values()],
      messages: [...this.messages.values()],
      processed: Object.fromEntries(this.processed),
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
  }
}
