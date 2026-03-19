/**
 * Ink — Polpo's package registry.
 *
 * Distributes three package types via git-native discovery:
 *   - Playbooks:  playbooks/<name>/playbook.json   (PlaybookDefinition)
 *   - Agents:     agents/<name>.json                (AgentConfig)
 *   - Companies:  companies/<name>/polpo.json       (PolpoFileConfig)
 *
 * Distribution model:
 *   - Git repos as the distribution mechanism (like skills.sh)
 *   - `polpo ink add owner/repo` clones and discovers by convention
 *   - ink.lock tracks installed packages with source repo + commit hash
 *
 * Security:
 *   - Structural validation (schema + size limits) runs locally
 *   - LLM security scan via ink.polpo.dev worker (cache-aside on content hash)
 *   - Interactive review with warnings for dangerous patterns
 */

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync, statSync, rmSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { createHash } from "node:crypto";

import type { AgentConfig, PolpoFileConfig } from "./types.js";
import type { PlaybookDefinition } from "./playbook.js";
import type { AgentStore } from "./agent-store.js";
import type { PlaybookStore } from "./playbook-store.js";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Strip ink-specific metadata fields (version, author, tags) from an agent
 * config so they don't end up persisted in polpo.json or agent stores.
 */
export function stripInkMetadata(agent: AgentConfig): AgentConfig {
  const clean = { ...agent };
  delete (clean as any).version;
  delete (clean as any).author;
  delete (clean as any).tags;
  return clean;
}

// ── Package Types ──────────────────────────────────────────────────────

/** The three package types distributable via Ink. */
export type InkPackageType = "playbook" | "agent" | "company";

/** A parsed source identifier for an Ink registry repo. */
export interface InkSource {
  type: "github" | "local";
  /** For GitHub: the clone URL. For local: absolute path. */
  url: string;
  /** GitHub owner/repo slug (only for type: "github"). */
  ownerRepo?: string;
}

/** A discovered package within a registry repo. */
export interface InkPackage {
  /** Package type: playbook, agent, or company. */
  type: InkPackageType;
  /** Package name (derived from directory/file name). */
  name: string;
  /** Absolute path to the package file (playbook.json, agent.json, or polpo.json). */
  path: string;
  /** SHA-256 hash of the file content (for verdict caching). */
  contentHash: string;
  /** The parsed content. */
  content: PlaybookDefinition | AgentConfig | PolpoFileConfig;
  /** Optional metadata extracted from the content. */
  metadata: InkPackageMetadata;
}

/** Common metadata extracted from any package type. */
export interface InkPackageMetadata {
  version?: string;
  author?: string;
  tags?: string[];
  description?: string;
}

// ── Security Verdict ───────────────────────────────────────────────────

/** Security scan result for a package. */
export type InkVerdictLevel = "safe" | "warning" | "dangerous";

export interface InkVerdict {
  /** Overall verdict. */
  level: InkVerdictLevel;
  /** Human-readable explanation of findings. */
  details: string[];
  /** ISO timestamp of when the scan was performed. */
  scannedAt: string;
  /** Content hash this verdict applies to. */
  contentHash: string;
}

// ── Lock File ──────────────────────────────────────────────────────────

/** A single entry in ink.lock representing one installed registry source. */
export interface InkLockEntry {
  /** Source identifier (e.g. "acme-corp/polpo-registry"). */
  source: string;
  /** Git commit hash at time of installation. */
  commitHash: string;
  /** ISO timestamp of installation. */
  installedAt: string;
  /** Packages discovered and installed from this source. */
  packages: InkLockPackage[];
}

/** A single installed package within a lock entry. */
export interface InkLockPackage {
  type: InkPackageType;
  name: string;
  /** SHA-256 content hash for integrity verification. */
  contentHash: string;
  /** Security verdict at time of installation. */
  verdict?: InkVerdictLevel;
}

/** The full ink.lock file structure. */
export interface InkLockFile {
  /** Lock file format version. */
  version: 1;
  /** Installed registry sources. */
  registries: InkLockEntry[];
}

// ── Validation ─────────────────────────────────────────────────────────

/** Maximum file size for a single package JSON file (1 MB). */
const MAX_FILE_SIZE = 1024 * 1024;

/** Maximum number of packages per registry repo. */
const MAX_PACKAGES_PER_REGISTRY = 100;

export interface InkValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a playbook definition from a registry.
 * Checks structural integrity and flags suspicious patterns.
 */
export function validateInkPlaybook(def: unknown): InkValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!def || typeof def !== "object") {
    return { valid: false, errors: ["Not a valid JSON object"], warnings };
  }

  const obj = def as Record<string, unknown>;

  if (typeof obj.name !== "string" || !obj.name) {
    errors.push("Missing or invalid 'name' field");
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(obj.name)) {
    errors.push(`Invalid name '${obj.name}' — must be kebab-case`);
  }

  if (typeof obj.description !== "string" || !obj.description) {
    errors.push("Missing or invalid 'description' field");
  }

  if (!obj.mission || typeof obj.mission !== "object") {
    errors.push("Missing or invalid 'mission' field");
  }

  if (obj.parameters !== undefined) {
    if (!Array.isArray(obj.parameters)) {
      errors.push("'parameters' must be an array");
    }
  }

  // Warn on optional metadata fields with wrong types
  if (obj.version !== undefined && typeof obj.version !== "string") {
    warnings.push("'version' should be a string");
  }
  if (obj.author !== undefined && typeof obj.author !== "string") {
    warnings.push("'author' should be a string");
  }
  if (obj.tags !== undefined && (!Array.isArray(obj.tags) || !obj.tags.every((t: unknown) => typeof t === "string"))) {
    warnings.push("'tags' should be an array of strings");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate an agent config from a registry.
 * Checks structural integrity and flags suspicious patterns.
 */
export function validateInkAgent(def: unknown): InkValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!def || typeof def !== "object") {
    return { valid: false, errors: ["Not a valid JSON object"], warnings };
  }

  const obj = def as Record<string, unknown>;

  if (typeof obj.name !== "string" || !obj.name) {
    errors.push("Missing or invalid 'name' field");
  }

  // Security warnings
  if (typeof obj.systemPrompt === "string" && obj.systemPrompt.length > 0) {
    warnings.push("Agent has a custom systemPrompt — review for prompt injection");
  }

  if (Array.isArray(obj.allowedTools)) {
    const dangerousTools = ["bash", "exec", "write", "edit"];
    const found = (obj.allowedTools as string[]).filter(t => dangerousTools.some(d => t.includes(d)));
    if (found.length > 0) {
      warnings.push(`Agent allows potentially dangerous tools: ${found.join(", ")}`);
    }
  }

  // Warn on optional metadata fields with wrong types
  if (obj.version !== undefined && typeof obj.version !== "string") {
    warnings.push("'version' should be a string");
  }
  if (obj.author !== undefined && typeof obj.author !== "string") {
    warnings.push("'author' should be a string");
  }
  if (obj.tags !== undefined && (!Array.isArray(obj.tags) || !obj.tags.every((t: unknown) => typeof t === "string"))) {
    warnings.push("'tags' should be an array of strings");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Validate a company config (polpo.json) from a registry.
 */
export function validateInkCompany(def: unknown): InkValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!def || typeof def !== "object") {
    return { valid: false, errors: ["Not a valid JSON object"], warnings };
  }

  const obj = def as Record<string, unknown>;

  const hasProject = typeof obj.project === "string" && !!obj.project;
  if (!hasProject) {
    errors.push("Missing or invalid 'project' field");
  }

  if (obj.teams !== undefined && !Array.isArray(obj.teams)) {
    // Also accept legacy singular 'team'
    if (obj.team === undefined || typeof obj.team !== "object") {
      errors.push("Missing 'teams' array or legacy 'team' object");
    }
  }

  // Security: check agents within teams for systemPrompt injection
  const teams = (Array.isArray(obj.teams) ? obj.teams : obj.team ? [obj.team] : []) as Array<Record<string, unknown>>;
  for (const team of teams) {
    const agents = (Array.isArray(team.agents) ? team.agents : []) as Array<Record<string, unknown>>;
    for (const agent of agents) {
      if (typeof agent.systemPrompt === "string" && agent.systemPrompt.length > 0) {
        warnings.push(`Agent '${agent.name ?? "unknown"}' in team '${team.name ?? "unknown"}' has a custom systemPrompt — review for prompt injection`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Source Parsing ─────────────────────────────────────────────────────

/**
 * Parse an Ink source identifier into a structured source object.
 * Supports: owner/repo, full GitHub URLs, local paths.
 * Reuses the same logic as parseSkillSource() from the skills system.
 */
export function parseInkSource(input: string): InkSource {
  // Local path
  if (input.startsWith("/") || input.startsWith("./") || input.startsWith("../") || input === ".") {
    return { type: "local", url: resolve(input) };
  }

  // Full GitHub URL
  const ghUrlMatch = input.match(/github\.com\/([^/]+\/[^/]+)/);
  if (ghUrlMatch) {
    const ownerRepo = ghUrlMatch[1].replace(/\.git$/, "");
    return {
      type: "github",
      url: `https://github.com/${ownerRepo}.git`,
      ownerRepo,
    };
  }

  // owner/repo shorthand
  if (/^[^/]+\/[^/]+$/.test(input)) {
    return {
      type: "github",
      url: `https://github.com/${input}.git`,
      ownerRepo: input,
    };
  }

  // Assume it's a git URL
  return { type: "github", url: input };
}

// ── Content Hashing ────────────────────────────────────────────────────

/** Compute SHA-256 hash of file content for verdict caching. */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Convention-Based Discovery ─────────────────────────────────────────

/**
 * Discover all packages in a registry directory by convention.
 *
 * Scans:
 *   - playbooks/<name>/playbook.json  → PlaybookDefinition
 *   - agents/<name>.json              → AgentConfig
 *   - companies/<name>/polpo.json     → PolpoFileConfig
 *
 * Returns validated packages with content hashes.
 */
export function discoverInkPackages(registryDir: string): { packages: InkPackage[]; errors: string[] } {
  const packages: InkPackage[] = [];
  const errors: string[] = [];

  if (!existsSync(registryDir)) {
    return { packages, errors: [`Registry directory not found: ${registryDir}`] };
  }

  // — Playbooks: playbooks/<name>/playbook.json
  const playbooksDir = join(registryDir, "playbooks");
  if (existsSync(playbooksDir)) {
    try {
      const entries = readdirSync(playbooksDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const playbookFile = join(playbooksDir, entry.name, "playbook.json");
        if (!existsSync(playbookFile)) continue;

        const result = loadAndValidatePackage(playbookFile, "playbook", entry.name);
        if (result.error) {
          errors.push(result.error);
        } else if (result.pkg) {
          packages.push(result.pkg);
        }
      }
    } catch (e) {
      errors.push(`Error scanning playbooks/: ${(e as Error).message}`);
    }
  }

  // — Agents: agents/<name>.json
  const agentsDir = join(registryDir, "agents");
  if (existsSync(agentsDir)) {
    try {
      const entries = readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const agentName = entry.name.replace(/\.json$/, "");
        const agentFile = join(agentsDir, entry.name);

        const result = loadAndValidatePackage(agentFile, "agent", agentName);
        if (result.error) {
          errors.push(result.error);
        } else if (result.pkg) {
          packages.push(result.pkg);
        }
      }
    } catch (e) {
      errors.push(`Error scanning agents/: ${(e as Error).message}`);
    }
  }

  // — Companies: companies/<name>/polpo.json
  const companiesDir = join(registryDir, "companies");
  if (existsSync(companiesDir)) {
    try {
      const entries = readdirSync(companiesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const companyFile = join(companiesDir, entry.name, "polpo.json");
        if (!existsSync(companyFile)) continue;

        const result = loadAndValidatePackage(companyFile, "company", entry.name);
        if (result.error) {
          errors.push(result.error);
        } else if (result.pkg) {
          packages.push(result.pkg);
        }
      }
    } catch (e) {
      errors.push(`Error scanning companies/: ${(e as Error).message}`);
    }
  }

  // Enforce package limit
  if (packages.length > MAX_PACKAGES_PER_REGISTRY) {
    errors.push(`Registry exceeds maximum of ${MAX_PACKAGES_PER_REGISTRY} packages (found ${packages.length})`);
  }

  return { packages, errors };
}

/** Load, validate, and hash a single package file. */
function loadAndValidatePackage(
  filePath: string,
  type: InkPackageType,
  name: string,
): { pkg?: InkPackage; error?: string } {
  try {
    // Size check
    const stats = statSync(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      return { error: `${type} '${name}': file exceeds ${MAX_FILE_SIZE} byte limit (${stats.size} bytes)` };
    }

    const raw = readFileSync(filePath, "utf-8");
    const contentHash = hashContent(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: `${type} '${name}': invalid JSON` };
    }

    // Validate by type
    let validation: InkValidationResult;
    switch (type) {
      case "playbook":
        validation = validateInkPlaybook(parsed);
        break;
      case "agent":
        validation = validateInkAgent(parsed);
        break;
      case "company":
        validation = validateInkCompany(parsed);
        break;
    }

    if (!validation.valid) {
      return { error: `${type} '${name}': ${validation.errors.join("; ")}` };
    }

    // Extract common metadata
    const obj = parsed as Record<string, unknown>;
    const metadata: InkPackageMetadata = {
      version: typeof obj.version === "string" ? obj.version : undefined,
      author: typeof obj.author === "string" ? obj.author : undefined,
      tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
      description: typeof obj.description === "string" ? obj.description : undefined,
    };

    return {
      pkg: {
        type,
        name,
        path: filePath,
        contentHash,
        content: parsed as PlaybookDefinition | AgentConfig | PolpoFileConfig,
        metadata,
      },
    };
  } catch (e) {
    return { error: `${type} '${name}': ${(e as Error).message}` };
  }
}

// ── Lock File Management ───────────────────────────────────────────────

const LOCK_FILE_NAME = "ink.lock";

/** Read the ink.lock file from a polpo directory. Returns empty lock if not found. */
export function readInkLock(polpoDir: string): InkLockFile {
  const lockPath = join(polpoDir, LOCK_FILE_NAME);
  if (!existsSync(lockPath)) {
    return { version: 1, registries: [] };
  }

  try {
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as InkLockFile;
    // Basic validation
    if (parsed.version !== 1 || !Array.isArray(parsed.registries)) {
      return { version: 1, registries: [] };
    }
    return parsed;
  } catch {
    return { version: 1, registries: [] };
  }
}

/** Write the ink.lock file to a polpo directory. */
export function writeInkLock(polpoDir: string, lock: InkLockFile): void {
  if (!existsSync(polpoDir)) {
    mkdirSync(polpoDir, { recursive: true });
  }
  const lockPath = join(polpoDir, LOCK_FILE_NAME);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

/** Add or update a registry entry in the lock file. */
export function upsertInkLockEntry(lock: InkLockFile, entry: InkLockEntry): InkLockFile {
  const idx = lock.registries.findIndex(r => r.source === entry.source);
  const updated = { ...lock, registries: [...lock.registries] };
  if (idx >= 0) {
    updated.registries[idx] = entry;
  } else {
    updated.registries.push(entry);
  }
  return updated;
}

/** Remove a registry entry from the lock file. */
export function removeInkLockEntry(lock: InkLockFile, source: string): InkLockFile {
  return {
    ...lock,
    registries: lock.registries.filter(r => r.source !== source),
  };
}

/** Check if a source is already installed in the lock file. */
export function isInkSourceInstalled(lock: InkLockFile, source: string): boolean {
  return lock.registries.some(r => r.source === source);
}

/** Get the installed entry for a source, or undefined. */
export function getInkLockEntry(lock: InkLockFile, source: string): InkLockEntry | undefined {
  return lock.registries.find(r => r.source === source);
}

// ── Uninstall ──────────────────────────────────────────────────────────

/**
 * Uninstall packages recorded in a lock entry.
 *
 * - Playbooks: removes via PlaybookStore
 * - Agents: removes from AgentStore
 * - Companies: removes legacy paths (merged config cannot be cleanly reversed)
 *
 * @param entry - The lock entry whose packages should be removed
 * @param polpoDir - Path to the .polpo directory
 * @param agentStore - AgentStore to remove agents from
 * @param playbookStore - PlaybookStore to remove playbooks from
 */
export async function uninstallInkPackages(
  entry: InkLockEntry,
  polpoDir: string,
  agentStore: AgentStore,
  playbookStore?: PlaybookStore,
): Promise<string[]> {
  const removed: string[] = [];

  for (const pkg of entry.packages) {
    switch (pkg.type) {
      case "playbook": {
        if (playbookStore) {
          const deleted = await playbookStore.delete(pkg.name);
          if (deleted) removed.push(`playbook: ${pkg.name}`);
        } else {
          // Fallback: direct filesystem removal (when store not available)
          const dir = join(polpoDir, "playbooks", pkg.name);
          if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
            removed.push(`playbook: ${pkg.name}`);
          }
        }
        break;
      }
      case "agent": {
        const deleted = await agentStore.deleteAgent(pkg.name);
        if (deleted) {
          removed.push(`agent: ${pkg.name}`);
        }
        break;
      }
      case "company": {
        // Companies merge teams/agents — can't cleanly reverse.
        // Remove legacy paths if present.
        const legacyDir = join(polpoDir, "ink-companies", pkg.name);
        if (existsSync(legacyDir)) {
          rmSync(legacyDir, { recursive: true, force: true });
        }
        removed.push(`company: ${pkg.name} (merged config preserved)`);
        break;
      }
    }
  }

  return removed;
}
