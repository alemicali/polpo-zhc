/**
 * Files of the hosted MCP servers: one folder per server under `.polpo/mcp-servers/` (see types.ts).
 * Read fresh on every call (task runners read them too), written atomically (temp + rename).
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MCP_SERVER_ID_PATTERN,
  type McpCallLog, type McpServerDeploy, type McpServerDraft, type McpServerMeta, type McpServerTestCase, type McpServerVersion, type PendingCall,
} from "./types.js";

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, "utf-8")) as T; } catch { return undefined; }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export class McpServerStore {
  readonly root: string;

  constructor(polpoDir: string) {
    this.root = join(polpoDir, "mcp-servers");
  }

  dir(id: string): string {
    if (!MCP_SERVER_ID_PATTERN.test(id)) throw new Error(`Invalid server id "${id}"`);
    return join(this.root, id);
  }

  ids(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((d) => MCP_SERVER_ID_PATTERN.test(d) && existsSync(join(this.root, d, "server.json"))).sort();
  }

  exists(id: string): boolean {
    return MCP_SERVER_ID_PATTERN.test(id) && existsSync(join(this.root, id, "server.json"));
  }

  meta(id: string): McpServerMeta | undefined {
    return this.exists(id) ? readJson<McpServerMeta>(join(this.dir(id), "server.json")) : undefined;
  }

  saveMeta(meta: McpServerMeta): void {
    writeJson(join(this.dir(meta.id), "server.json"), meta);
  }

  draft(id: string): McpServerDraft | undefined {
    return readJson<McpServerDraft>(join(this.dir(id), "draft.json"));
  }

  saveDraft(id: string, draft: McpServerDraft): void {
    writeJson(join(this.dir(id), "draft.json"), draft);
  }

  versions(id: string): McpServerVersion[] {
    const dir = join(this.dir(id), "versions");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => readJson<McpServerVersion>(join(dir, f)))
      .filter((v): v is McpServerVersion => !!v);
  }

  version(id: string, version: string): McpServerVersion | undefined {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return undefined;
    return readJson<McpServerVersion>(join(this.dir(id), "versions", `${version}.json`));
  }

  saveVersion(id: string, version: McpServerVersion): void {
    const file = join(this.dir(id), "versions", `${version.version}.json`);
    if (existsSync(file)) throw new Error(`Version ${version.version} already exists`);
    writeJson(file, version);
  }

  deploys(id: string): McpServerDeploy[] {
    return readJson<McpServerDeploy[]>(join(this.dir(id), "deploys.json")) ?? [];
  }

  addDeploy(id: string, entry: McpServerDeploy): void {
    writeJson(join(this.dir(id), "deploys.json"), [...this.deploys(id), entry]);
  }

  /** The production version (the last deploy's target). */
  production(id: string): string | undefined {
    return this.deploys(id).at(-1)?.to;
  }

  tests(id: string): McpServerTestCase[] {
    return readJson<McpServerTestCase[]>(join(this.dir(id), "tests.json")) ?? [];
  }

  saveTests(id: string, tests: McpServerTestCase[]): void {
    writeJson(join(this.dir(id), "tests.json"), tests);
  }

  log(id: string, entry: McpCallLog): void {
    if (!this.exists(id)) return;
    const file = join(this.dir(id), "logs.jsonl");
    try {
      if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
        // keep the newer half
        const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
        writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch { /* logging never breaks a call */ }
  }

  logs(id: string, limit = 100): McpCallLog[] {
    const file = join(this.dir(id), "logs.jsonl");
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().flatMap((l) => { try { return [JSON.parse(l) as McpCallLog]; } catch { return []; } });
  }

  pending(id: string): PendingCall[] {
    const dir = join(this.dir(id), "pending");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson<PendingCall>(join(dir, f))).filter((p): p is PendingCall => !!p)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  pendingCall(id: string, callId: string): PendingCall | undefined {
    if (!/^[\w-]{1,64}$/.test(callId)) return undefined;
    return readJson<PendingCall>(join(this.dir(id), "pending", `${callId}.json`));
  }

  savePending(call: PendingCall): void {
    writeJson(join(this.dir(call.serverId), "pending", `${call.id}.json`), call);
  }

  buildDir(id: string, version: string): string {
    return join(this.dir(id), "builds", version);
  }

  remove(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true });
  }
}
