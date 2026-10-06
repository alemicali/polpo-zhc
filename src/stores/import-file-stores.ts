/**
 * One-time import of the data that used to live only in .polpo files, the first time a project
 * runs on a database (SQLite or PostgreSQL): vault, push subscriptions and VAPID keys, Expo tokens,
 * token usage, context checkpoints, apps, data registry, storage registry, company brain, WhatsApp history.
 *
 * Each part runs once (a marker is kept in the metadata table), only into an empty table, and
 * never deletes or changes the files: they stay as a backup.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { DrizzleStores } from "@polpo-ai/drizzle";
import type { CompanyBrainSnapshot } from "@polpo-ai/core/company-brain";
import { FileTokenUsageStore } from "./file-token-usage-store.js";

type Log = (message: string) => void;

interface ImportContext {
  polpoDir: string;
  stores: DrizzleStores;
  db: any;
  /** pgSchema or sqliteSchema from @polpo-ai/drizzle. */
  schema: { metadata: any; vault: any };
  dialect: "pg" | "sqlite";
  log: Log;
}

const readJson = <T>(path: string): T | undefined => {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
};

async function done(ctx: ImportContext, name: string): Promise<boolean> {
  const rows: any[] = await ctx.db.select().from(ctx.schema.metadata).where(eq(ctx.schema.metadata.key, `file-import:${name}`));
  return rows.length > 0;
}

async function markDone(ctx: ImportContext, name: string, imported: number): Promise<void> {
  const value = { importedAt: new Date().toISOString(), imported };
  await ctx.db.insert(ctx.schema.metadata)
    .values({ key: `file-import:${name}`, value: ctx.dialect === "pg" ? value : JSON.stringify(value) })
    .onConflictDoNothing();
}

/**
 * System vault namespaces ("$data", "$providers", ...) are never shared with
 * agents: drop any allowedAgents on them when migrating file-store entries.
 */
export function sanitizeImportedVaultEntry<T extends { allowedAgents?: string[] }>(owner: string, entry: T): T {
  if (!owner.trim().startsWith("$") || !entry.allowedAgents) return entry;
  const { allowedAgents: _shared, ...rest } = entry;
  return rest as T;
}

/** Each importer returns how many items it copied; it runs only if the target is still empty. */
const IMPORTERS: Record<string, (ctx: ImportContext) => Promise<number>> = {
  async vault(ctx) {
    if (!existsSync(join(ctx.polpoDir, "vault.enc"))) return 0;
    if ((await ctx.db.select().from(ctx.schema.vault).limit(1)).length > 0) return 0;
    const { EncryptedVaultStore } = await import("../vault/encrypted-store.js");
    const entries = new EncryptedVaultStore(ctx.polpoDir).exportAll(); // throws if it cannot decrypt
    // Migrates every entry verbatim, including "$"-prefixed system namespaces
    // ("$data", "$providers"): vault.enc is written only by Polpo itself, and
    // dropping those owners here would lose data-source/provider secrets.
    // Reserved owners are blocked at the user/agent-facing boundaries instead;
    // system entries are never shared with agents, so allowedAgents is dropped.
    for (const { agent, service, entry } of entries) {
      await ctx.stores.vaultStore.set(agent, service, sanitizeImportedVaultEntry(agent, entry));
    }
    return entries.length;
  },

  async push(ctx) {
    const file = readJson<{ vapid?: any; subscriptions?: any[] }>(join(ctx.polpoDir, "push.json"));
    if (!file) return 0;
    const store = ctx.stores.pushSubscriptionStore;
    // The VAPID keys first: browsers subscribed with the old public key only accept that key.
    if (file.vapid?.publicKey && file.vapid.privateKey && !(await store.getVapid())) await store.setVapid(file.vapid);
    if ((await store.count()) > 0) return 0;
    await store.importRecords(file.subscriptions ?? []);
    return file.subscriptions?.length ?? 0;
  },

  async expo(ctx) {
    const file = readJson<{ tokens?: any[] }>(join(ctx.polpoDir, "expo-tokens.json"));
    if (!file?.tokens?.length || (await ctx.stores.expoTokenStore.count()) > 0) return 0;
    await ctx.stores.expoTokenStore.importRecords(file.tokens);
    return file.tokens.length;
  },

  async tokenUsage(ctx) {
    if (!existsSync(join(ctx.polpoDir, "usage"))) return 0;
    if ((await ctx.stores.tokenUsageStore.list("all")).length > 0) return 0;
    const records = await new FileTokenUsageStore(ctx.polpoDir).list("all");
    await ctx.stores.tokenUsageStore.recordMany(records);
    return records.length;
  },

  async contextCheckpoints(ctx) {
    const dir = join(ctx.polpoDir, "context-checkpoints");
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const sessionId = file.slice(0, -".json".length);
      const checkpoint = readJson<any>(join(dir, file));
      if (checkpoint && (await ctx.stores.contextCheckpointStore.save(sessionId, checkpoint, null))) n++;
    }
    return n;
  },

  async apps(ctx) {
    const file = readJson<{ apps?: any[] }>(join(ctx.polpoDir, "apps.json"));
    if (!file?.apps?.length || (await ctx.stores.appRegistryStore.list()).length > 0) return 0;
    await ctx.stores.appRegistryStore.importApps(file.apps);
    return file.apps.length;
  },

  async dataRegistry(ctx) {
    const file = readJson<{ sources?: any[]; views?: any[]; activity?: any[] }>(join(ctx.polpoDir, "data.json"));
    if (!file) return 0;
    const store = ctx.stores.dataRegistryStore;
    if ((await store.listSources()).length > 0 || (await store.listViews()).length > 0) return 0;
    const data = { sources: file.sources ?? [], views: file.views ?? [], activity: file.activity ?? [] };
    await store.importAll(data);
    return data.sources.length + data.views.length + data.activity.length;
  },

  async storageRegistry(ctx) {
    const file = readJson<{ entries?: any[] }>(join(ctx.polpoDir, "storage.json"));
    if (!file?.entries?.length || (await ctx.stores.storageRegistryStore.list()).length > 0) return 0;
    await ctx.stores.storageRegistryStore.importEntries(file.entries);
    return file.entries.length;
  },

  async companyBrain(ctx) {
    const file = readJson<Partial<CompanyBrainSnapshot>>(join(ctx.polpoDir, "company-brain.json"));
    if (!file) return 0;
    const store = ctx.stores.companyBrainStore;
    const current = await store.snapshot();
    if (current.entities.length || current.relations.length || current.claims.length || current.grants.length) return 0;
    let n = 0;
    await store.transaction((snapshot) => {
      for (const key of ["entities", "relations", "claims", "grants", "runs", "activity"] as const) {
        const items = Array.isArray(file[key]) ? (file[key] as any[]) : [];
        (snapshot[key] as any[]) = items;
        n += items.length;
      }
    });
    return n;
  },

  async whatsapp(ctx) {
    const path = join(ctx.polpoDir, "whatsapp.db");
    if (!existsSync(path) || (await ctx.stores.whatsappStore.messageCount()) > 0) return 0;
    const { createRequire } = await import("node:module");
    const Database = createRequire(import.meta.url)("better-sqlite3");
    const source = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const has = (table: string) => !!source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      let n = 0;
      if (has("contacts")) {
        for (const c of source.prepare("SELECT * FROM contacts").all() as any[]) {
          await ctx.stores.whatsappStore.upsertContact(c.jid, c.name, c.last_seen);
          n++;
        }
      }
      if (has("messages")) {
        for (const m of source.prepare("SELECT * FROM messages ORDER BY timestamp").all() as any[]) {
          await ctx.stores.whatsappStore.appendMessage({
            id: m.id, chatJid: m.chat_jid, senderJid: m.sender_jid, senderName: m.sender_name ?? undefined,
            text: m.text, fromMe: !!m.from_me, timestamp: m.timestamp,
            mediaType: m.media_type ?? undefined, mediaPath: m.media_path ?? undefined, mimeType: m.mime_type ?? undefined,
            fileName: m.file_name ?? undefined, mediaSize: m.media_size ?? undefined, readAt: m.read_at ?? undefined,
          });
          n++;
        }
      }
      return n;
    } finally {
      source.close();
    }
  },
};

export async function importFileStores(ctx: ImportContext): Promise<void> {
  for (const [name, run] of Object.entries(IMPORTERS)) {
    if (await done(ctx, name)) continue;
    try {
      const imported = await run(ctx);
      await markDone(ctx, name, imported);
      if (imported > 0) ctx.log(`Imported ${imported} ${name} item(s) from .polpo files into the database (files kept as a backup).`);
    } catch (err) {
      // Not marked done: retried at the next start. The file is untouched.
      ctx.log(`Could not import ${name} from .polpo files: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
