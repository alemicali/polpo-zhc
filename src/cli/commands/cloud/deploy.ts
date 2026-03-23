/**
 * polpo-cloud deploy — sync local .polpo/ project to cloud.
 *
 * Core (always deployed):
 *   - polpo.json (config)
 *   - agents.json (agent definitions)
 *   - teams.json (team structure)
 *   - memory.md + memory/<agent>.md (knowledge base)
 *   - playbooks/ (mission templates)
 *   - missions/ (mission definitions + checkpoints + delays)
 *   - approvals (approval state)
 *
 * Opt-in (with flags):
 *   --include-tasks     Deploy tasks
 *   --include-runs      Deploy run records
 *   --include-sessions  Deploy chat sessions
 *   --all               Deploy everything (seamless local→cloud migration)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import { loadCredentials, saveCredentials } from "./config.js";
import { createApiClient, type ApiClient } from "./api.js";
import { isTTY, confirm } from "./prompt.js";
import { resolveKey, decrypt } from "@polpo-ai/vault-crypto";

function resolvePolpoDir(dir: string): string {
  const polpoDir = path.resolve(dir, ".polpo");
  if (!fs.existsSync(polpoDir)) {
    console.error(`Error: .polpo/ directory not found in ${path.resolve(dir)}`);
    process.exit(1);
  }
  return polpoDir;
}

function loadJson(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    console.error(`Warning: Could not parse ${filePath}`);
    return null;
  }
}

function loadText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".json")).map(f => path.join(dir, f));
}

// ── Core deployers ──────────────────────────────────────

async function deployTeams(client: ApiClient, polpoDir: string): Promise<number> {
  const teams = loadJson(path.join(polpoDir, "teams.json"));
  if (!teams || !Array.isArray(teams)) return 0;
  let count = 0;
  for (const team of teams) {
    try {
      await client.post("/v1/agents/teams", { name: team.name, description: team.description });
      count++;
    } catch { /* team may already exist */ }
  }
  return count;
}

async function deployAgents(client: ApiClient, polpoDir: string): Promise<number> {
  const agents = loadJson(path.join(polpoDir, "agents.json"));
  if (!agents || !Array.isArray(agents)) return 0;
  let count = 0;
  for (const entry of agents) {
    const agent = entry.agent ?? entry;
    const teamName = entry.teamName ?? "default";
    try {
      await client.post("/v1/agents", { ...agent, team: teamName });
      count++;
    } catch (err: any) {
      console.error(`  Warning: agent "${agent.name}": ${err.message}`);
    }
  }
  return count;
}

async function deployMemory(client: ApiClient, polpoDir: string): Promise<number> {
  let count = 0;
  // Shared memory
  const shared = loadText(path.join(polpoDir, "memory.md"));
  if (shared) {
    try {
      await client.put("/v1/memory", { content: shared });
      count++;
    } catch { /* ignore */ }
  }
  // Agent-specific memories
  const memDir = path.join(polpoDir, "memory");
  if (fs.existsSync(memDir)) {
    for (const file of fs.readdirSync(memDir).filter(f => f.endsWith(".md"))) {
      const agentName = file.replace(".md", "");
      const content = loadText(path.join(memDir, file));
      if (content) {
        try {
          await client.put(`/v1/memory/agent/${agentName}`, { content });
          count++;
        } catch { /* ignore */ }
      }
    }
  }
  return count;
}

async function deployMissions(client: ApiClient, polpoDir: string): Promise<number> {
  const files = listJsonFiles(path.join(polpoDir, "missions"));
  let count = 0;
  for (const file of files) {
    const mission = loadJson(file);
    if (!mission) continue;
    try {
      await client.post("/v1/missions", {
        name: mission.name,
        data: typeof mission.data === "string" ? mission.data : JSON.stringify(mission.data),
        prompt: mission.prompt,
        status: mission.status ?? "draft",
        schedule: mission.schedule,
        deadline: mission.deadline,
        notifications: mission.notifications,
      });
      count++;
    } catch (err: any) {
      console.error(`  Warning: mission "${mission.name}": ${err.message}`);
    }
  }
  return count;
}

async function deployPlaybooks(client: ApiClient, polpoDir: string): Promise<number> {
  const playbooksDir = path.join(polpoDir, "playbooks");
  if (!fs.existsSync(playbooksDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(playbooksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pbFile = path.join(playbooksDir, entry.name, "playbook.json");
    const playbook = loadJson(pbFile);
    if (!playbook) continue;
    try {
      await client.post("/v1/playbooks", {
        name: playbook.name ?? entry.name,
        description: playbook.description,
        mission: typeof playbook.mission === "string" ? playbook.mission : JSON.stringify(playbook.mission),
        parameters: playbook.parameters,
      });
      count++;
    } catch (err: any) {
      console.error(`  Warning: playbook "${entry.name}": ${err.message}`);
    }
  }
  return count;
}

async function deploySkills(client: ApiClient, polpoDir: string): Promise<number> {
  const skillsDir = path.join(polpoDir, "skills");
  if (!fs.existsSync(skillsDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;

    const raw = fs.readFileSync(skillFile, "utf-8");

    // Parse frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    let name = entry.name;
    let description = "";
    let allowedTools: string[] | undefined;

    if (fmMatch) {
      const lines = fmMatch[1].split("\n");
      let currentArray: string[] | null = null;
      for (const line of lines) {
        const arrayItem = line.match(/^\s+-\s+(.+)/);
        if (arrayItem && currentArray) {
          currentArray.push(arrayItem[1].trim());
          continue;
        }
        currentArray = null;
        const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)?/);
        if (kv) {
          const key = kv[1];
          const val = kv[2]?.trim();
          if (key === "name" && val) name = val;
          if (key === "description" && val) description = val;
          if (key === "allowed-tools" || key === "allowedTools") {
            allowedTools = [];
            currentArray = allowedTools;
          }
        }
      }
    }

    // Extract body (everything after frontmatter)
    const bodyMatch = raw.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    const content = bodyMatch ? bodyMatch[1].trim() : raw.trim();

    try {
      await client.post("/v1/skills/create", {
        name,
        description,
        content,
        ...(allowedTools?.length ? { allowedTools } : {}),
      });
      count++;
    } catch (err: any) {
      // Skill may already exist — try to check if it's a duplicate error
      if (err.message?.includes("already exists") || err.status === 400) {
        // Already exists — skip silently
      } else {
        console.error(`  Warning: skill "${name}": ${err.message}`);
      }
    }
  }
  return count;
}

async function deployVault(client: ApiClient, polpoDir: string): Promise<number> {
  const vaultPath = path.join(polpoDir, "vault.enc");
  if (!fs.existsSync(vaultPath)) return 0;

  let key: Buffer;
  try {
    key = resolveKey();
  } catch (err: any) {
    console.error(`  Warning: cannot resolve vault key: ${err.message}`);
    console.error(`  Set POLPO_VAULT_KEY env var or ensure ~/.polpo/vault.key exists.`);
    return 0;
  }

  const encrypted = fs.readFileSync(vaultPath);
  let vaultData: Record<string, Record<string, any>>;
  try {
    const plaintext = decrypt(encrypted, key);
    vaultData = JSON.parse(plaintext.toString("utf-8"));
  } catch (err: any) {
    console.error(`  Warning: cannot decrypt vault: ${err.message}`);
    return 0;
  }

  let count = 0;
  for (const [agent, services] of Object.entries(vaultData)) {
    for (const [service, entry] of Object.entries(services)) {
      try {
        await client.post("/v1/vault/entries", {
          agent,
          service,
          type: entry.type ?? "custom",
          label: entry.label,
          credentials: entry.credentials,
        });
        count++;
      } catch (err: any) {
        console.error(`  Warning: vault "${agent}/${service}": ${err.message}`);
      }
    }
  }
  return count;
}

async function deployAvatars(client: ApiClient, polpoDir: string, baseUrl: string, apiKey: string): Promise<number> {
  const avatarsDir = path.join(polpoDir, "avatars");
  if (!fs.existsSync(avatarsDir)) return 0;
  const files = fs.readdirSync(avatarsDir).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(ext);
  });
  if (files.length === 0) return 0;

  // Ensure .polpo/avatars/ exists in the sandbox
  try {
    await fetch(`${baseUrl}/v1/files/mkdir`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: ".polpo/avatars" }),
    });
  } catch { /* may already exist */ }

  let count = 0;
  for (const file of files) {
    const filePath = path.join(avatarsDir, file);
    const fileData = fs.readFileSync(filePath);

    // Upload via multipart form to /v1/files/upload
    const formData = new FormData();
    formData.append("path", ".polpo/avatars");
    formData.append("file", new Blob([fileData]), file);

    try {
      const res = await fetch(`${baseUrl}/v1/files/upload`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: formData,
      });
      if (res.ok) {
        count++;
      } else {
        console.error(`  Warning: avatar "${file}": HTTP ${res.status}`);
      }
    } catch (err: any) {
      console.error(`  Warning: avatar "${file}": ${err.message}`);
    }
  }
  return count;
}

async function deployApprovals(client: ApiClient, polpoDir: string): Promise<number> {
  const approvals = loadJson(path.join(polpoDir, "approvals.json"));
  if (!approvals || !Array.isArray(approvals)) return 0;
  // Approvals are read-only in the API for now — skip
  return 0;
}

// ── Opt-in deployers ──────────────────────────────────────

async function deployTasks(client: ApiClient, polpoDir: string): Promise<number> {
  const files = listJsonFiles(path.join(polpoDir, "tasks"));
  let count = 0;
  for (const file of files) {
    const task = loadJson(file);
    if (!task) continue;
    try {
      await client.post("/v1/tasks", {
        title: task.title,
        description: task.description,
        assignTo: task.assignTo,
        group: task.group,
        missionId: task.missionId,
        dependsOn: task.dependsOn,
        expectations: task.expectations,
        metrics: task.metrics,
        maxRetries: task.maxRetries,
        maxDuration: task.maxDuration,
        deadline: task.deadline,
        priority: task.priority,
      });
      count++;
    } catch (err: any) {
      console.error(`  Warning: task "${task.title}": ${err.message}`);
    }
  }
  return count;
}

async function deployRuns(client: ApiClient, polpoDir: string): Promise<number> {
  // Runs are runtime state — deploy for migration only
  const files = listJsonFiles(path.join(polpoDir, "runs"));
  // Skip: runs are managed by the orchestrator, not created via API
  return files.length > 0 ? files.length : 0;
}

async function deploySessions(client: ApiClient, polpoDir: string): Promise<number> {
  const sessionsDir = path.join(polpoDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return 0;
  const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
  let count = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(sessionsDir, file), "utf-8");
    const lines = raw.split("\n").filter(l => l.trim());
    if (lines.length === 0) continue;

    // First line is session metadata
    let title: string | undefined;
    let agent: string | undefined;
    const messages: Array<{ role: "user" | "assistant"; content: string; toolCalls?: unknown[] }> = [];

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._session) {
          title = obj.title;
          agent = obj.agent;
        } else if (obj.role && obj.content) {
          messages.push({
            role: obj.role,
            content: obj.content,
            ...(obj.toolCalls ? { toolCalls: obj.toolCalls } : {}),
          });
        }
      } catch { /* skip malformed lines */ }
    }

    if (messages.length === 0) continue;

    try {
      await client.post("/v1/chat/sessions/import", { title, agent, messages });
      count++;
    } catch (err: any) {
      console.error(`  Warning: session "${title ?? file}": ${err.message}`);
    }
  }

  return count;
}

// ── Main command ──────────────────────────────────────

export function registerDeployCommand(program: Command): void {
  program
    .command("deploy")
    .description("Deploy local .polpo/ project to cloud")
    .option("--dir <path>", "Project directory", ".")
    .option("--yes", "Skip confirmation prompt")
    .option("--include-tasks", "Also deploy tasks")
    .option("--include-runs", "Also deploy run records (migration)")
    .option("--include-sessions", "Also deploy chat sessions (migration)")
    .option("--all", "Deploy everything (full local→cloud migration)")
    .action(async (opts) => {
      const creds = loadCredentials();
      if (!creds) {
        console.error("Not logged in. Run: polpo login");
        process.exit(1);
      }

      const polpoDir = resolvePolpoDir(opts.dir);
      const client = createApiClient(creds);
      const polpoConfig = loadJson(path.join(polpoDir, "polpo.json"));
      const projectName = polpoConfig?.project ?? path.basename(path.resolve(opts.dir));

      console.log("\n  Polpo Deploy\n");

      // ── Step 1: Resolve project ────────────────────────
      let projectId: string | undefined = creds.projectId;
      let orgId: string | undefined;

      if (!projectId) {
        try {
          const orgsRes = await client.get<any>("/v1/orgs");
          const orgs = Array.isArray(orgsRes.data) ? orgsRes.data : [];
          if (orgs.length > 0) {
            orgId = orgs[0].id;

            const projRes = await client.get<any>(`/v1/projects?orgId=${orgId}`);
            const projects = Array.isArray(projRes.data) ? projRes.data : [];
            const existing = projects.find((p: any) =>
              p.name?.toLowerCase() === projectName.toLowerCase() ||
              p.slug?.toLowerCase() === projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-")
            );

            if (existing) {
              projectId = existing.id;
              console.log(`  Project: ${existing.name}\n`);
            } else if (isTTY()) {
              const slug = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
              const ok = await confirm(`  Project "${projectName}" not found. Create it?`);
              if (ok) {
                const createRes = await client.post<any>("/v1/projects", { name: projectName, slug, orgId });
                projectId = createRes.data?.id;
                console.log(`\n  Project: ${projectName} (created)\n`);
              } else {
                console.log("  Aborted.");
                process.exit(0);
              }
            } else {
              console.error(`  Project "${projectName}" not found.`);
              process.exit(1);
            }
          }
        } catch {
          // Control plane auth may not support /v1/orgs — continue without project linking
        }
      }

      if (!projectId) {
        console.log(`  Project: ${projectName}\n`);
      }

      // Save projectId for future deploys
      if (projectId && !creds.projectId) {
        saveCredentials(creds.apiKey, creds.baseUrl, projectId);
      }

      // ── Step 2: Detect LLM keys ────────────────────────
      const LLM_KEYS: Record<string, string> = {
        ANTHROPIC_API_KEY: "anthropic",
        OPENAI_API_KEY: "openai",
        GEMINI_API_KEY: "google",
        XAI_API_KEY: "xai",
        GROQ_API_KEY: "groq",
        OPENROUTER_API_KEY: "openrouter",
        MISTRAL_API_KEY: "mistral",
        CEREBRAS_API_KEY: "cerebras",
        MINIMAX_API_KEY: "minimax",
        HF_TOKEN: "huggingface",
        AZURE_OPENAI_API_KEY: "azure-openai-responses",
      };

      const detected: { envVar: string; provider: string; value: string }[] = [];

      // Check process.env
      for (const [envVar, provider] of Object.entries(LLM_KEYS)) {
        if (process.env[envVar]) {
          detected.push({ envVar, provider, value: process.env[envVar]! });
        }
      }

      // Check .polpo/.env
      const envFile = path.join(polpoDir, ".env");
      if (fs.existsSync(envFile)) {
        for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
          const t = line.trim();
          if (!t || t.startsWith("#")) continue;
          const eq = t.indexOf("=");
          if (eq === -1) continue;
          const k = t.slice(0, eq).trim();
          const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
          if (LLM_KEYS[k] && v && !detected.find(d => d.envVar === k)) {
            detected.push({ envVar: k, provider: LLM_KEYS[k], value: v });
          }
        }
      }

      if (detected.length > 0) {
        console.log("  Detected LLM keys:");
        for (const { envVar, value } of detected) {
          console.log(`    ${envVar.padEnd(25)} ${value.slice(0, 8)}...${value.slice(-4)}`);
        }
        console.log();

        if (isTTY() && !opts.yes) {
          const push = await confirm("  Push LLM keys to cloud?");
          if (push) {
            let n = 0;
            for (const { provider, value } of detected) {
              try { await client.post("/v1/byok", { provider, key: value }); n++; } catch {}
            }
            if (n > 0) console.log(`  Pushed ${n} LLM key(s)\n`);
          } else {
            console.log();
          }
        }
      }

      // ── Step 3: Scan resources ────────────────────────
      const hasTeams = fs.existsSync(path.join(polpoDir, "teams.json"));
      const hasAgents = fs.existsSync(path.join(polpoDir, "agents.json"));
      const hasMemory = fs.existsSync(path.join(polpoDir, "memory.md")) ||
        fs.existsSync(path.join(polpoDir, "memory"));
      const hasMissions = fs.existsSync(path.join(polpoDir, "missions")) &&
        fs.readdirSync(path.join(polpoDir, "missions")).length > 0;
      const hasPlaybooks = fs.existsSync(path.join(polpoDir, "playbooks"));
      const hasSkills = fs.existsSync(path.join(polpoDir, "skills")) &&
        fs.readdirSync(path.join(polpoDir, "skills")).some(
          (d) => fs.statSync(path.join(polpoDir, "skills", d)).isDirectory()
        );
      const hasVault = fs.existsSync(path.join(polpoDir, "vault.enc"));
      const hasAvatars = fs.existsSync(path.join(polpoDir, "avatars")) &&
        fs.readdirSync(path.join(polpoDir, "avatars")).length > 0;
      const hasTasks = fs.existsSync(path.join(polpoDir, "tasks")) &&
        fs.readdirSync(path.join(polpoDir, "tasks")).length > 0;
      const hasRuns = fs.existsSync(path.join(polpoDir, "runs")) &&
        fs.readdirSync(path.join(polpoDir, "runs")).length > 0;
      const hasSessions = fs.existsSync(path.join(polpoDir, "sessions")) &&
        fs.readdirSync(path.join(polpoDir, "sessions")).length > 0;

      const includeTasks = opts.all || opts.includeTasks;
      const includeRuns = opts.all || opts.includeRuns;
      const includeSessions = opts.all || opts.includeSessions;

      console.log("  Resources:");
      if (hasTeams) console.log("    Teams ........... yes");
      if (hasAgents) console.log("    Agents .......... yes");
      if (hasMemory) console.log("    Memory .......... yes");
      if (hasMissions) console.log("    Missions ........ yes");
      if (hasPlaybooks) console.log("    Playbooks ....... yes");
      if (hasSkills) console.log("    Skills .......... yes");
      if (hasVault) console.log("    Vault ........... yes");
      if (hasAvatars) console.log("    Avatars ......... yes");
      if (hasSessions) console.log("    Sessions ........ yes");
      if (includeTasks && hasTasks) console.log("    Tasks ........... yes");
      if (includeRuns && hasRuns) console.log("    Runs ............ yes");
      if (includeSessions && hasSessions) console.log("    Sessions ........ yes");
      console.log("");

      if (!opts.yes && isTTY()) {
        const ok = await confirm("  Deploy?");
        if (!ok) {
          console.log("  Aborted.");
          process.exit(0);
        }
        console.log();
      }

      // ── Step 4: Deploy ────────────────────────
      console.log("  Deploying...");
      const results: string[] = [];

      if (hasTeams) {
        const n = await deployTeams(client, polpoDir);
        if (n > 0) results.push(`${n} team(s)`);
      }

      if (hasAgents) {
        const n = await deployAgents(client, polpoDir);
        if (n > 0) results.push(`${n} agent(s)`);
      }

      if (hasMemory) {
        const n = await deployMemory(client, polpoDir);
        if (n > 0) results.push(`${n} memory file(s)`);
      }

      if (hasMissions) {
        const n = await deployMissions(client, polpoDir);
        if (n > 0) results.push(`${n} mission(s)`);
      }

      if (hasPlaybooks) {
        const n = await deployPlaybooks(client, polpoDir);
        if (n > 0) results.push(`${n} playbook(s)`);
      }

      if (hasSkills) {
        const n = await deploySkills(client, polpoDir);
        if (n > 0) results.push(`${n} skill(s)`);
      }

      if (hasVault) {
        const n = await deployVault(client, polpoDir);
        if (n > 0) results.push(`${n} vault entry(ies)`);
      }

      if (hasAvatars) {
        const n = await deployAvatars(client, polpoDir, creds.baseUrl, creds.apiKey);
        if (n > 0) results.push(`${n} avatar(s)`);
      }

      if (hasSessions) {
        const n = await deploySessions(client, polpoDir);
        if (n > 0) results.push(`${n} session(s)`);
      }

      // Deploy opt-in
      if (includeTasks && hasTasks) {
        const n = await deployTasks(client, polpoDir);
        if (n > 0) results.push(`${n} task(s)`);
      }

      if (includeRuns && hasRuns) {
        const n = await deployRuns(client, polpoDir);
        if (n > 0) results.push(`${n} run(s) (skipped — needs import API)`);
      }


      console.log(`\nDeployed: ${results.join(", ") || "nothing to deploy"}`);
    });
}
