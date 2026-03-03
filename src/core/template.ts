/**
 * Template system — parameterized, reusable mission templates.
 *
 * A template is a JSON file (template.json) that defines a MissionDocument with
 * placeholder parameters ({{name}}). When executed, parameters are resolved
 * and the result is saved + executed as a standard Mission.
 *
 * Discovery paths (in priority order, first occurrence wins):
 *   1. <polpoDir>/templates/          — project-level templates
 *   2. <cwd>/.polpo/templates/        — alias for polpoDir when polpoDir != .polpo
 *   3. ~/.polpo/templates/            — user-level templates
 *
 * File layout:
 *   .polpo/templates/
 *     code-review/
 *       template.json
 *     bug-fix/
 *       template.json
 */

import { readdirSync, readFileSync, existsSync, realpathSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ── Types ──────────────────────────────────────────────────────────────

export interface TemplateParameter {
  /** Parameter name — used as {{name}} in the mission template. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Value type. Default: "string". */
  type?: "string" | "number" | "boolean";
  /** Whether the parameter must be provided. Default: false. */
  required?: boolean;
  /** Default value when not provided. */
  default?: string | number | boolean;
  /** Allowed values (enum constraint). */
  enum?: (string | number)[];
}

export interface TemplateDefinition {
  /** Template identifier (kebab-case). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Parameterized mission template — same shape as MissionDocument. */
  mission: Record<string, unknown>;
  /** Declared parameters. */
  parameters?: TemplateParameter[];
}

/** Lightweight metadata returned by discovery (no mission body). */
export interface TemplateInfo {
  name: string;
  description: string;
  parameters: TemplateParameter[];
  /** Absolute path to the template directory. */
  path: string;
}

// ── Discovery ──────────────────────────────────────────────────────────

function scanTemplateDir(dir: string): TemplateInfo[] {
  if (!existsSync(dir)) return [];

  const results: TemplateInfo[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(dir, entry);

    // Follow symlinks
    let realPath: string;
    try {
      realPath = realpathSync(entryPath);
    } catch {
      continue; // broken symlink
    }

    // Must be a directory
    try {
      if (!statSync(realPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // Must contain template.json
    const templateFile = join(realPath, "template.json");
    if (!existsSync(templateFile)) continue;

    try {
      const raw = readFileSync(templateFile, "utf-8");
      const def = JSON.parse(raw) as Partial<TemplateDefinition>;

      if (!def.name || !def.description || !def.mission) continue;

      results.push({
        name: def.name,
        description: def.description,
        parameters: def.parameters ?? [],
        path: realPath,
      });
    } catch {
      // Invalid JSON — skip silently
    }
  }

  return results;
}

/**
 * Discover all available templates from known locations.
 * Returns deduplicated list (first occurrence wins by name).
 */
export function discoverTemplates(cwd: string, polpoDir?: string): TemplateInfo[] {
  const seen = new Set<string>();
  const results: TemplateInfo[] = [];

  const dirs: string[] = [];

  // 1. Project-level: <polpoDir>/templates/
  if (polpoDir) {
    dirs.push(join(polpoDir, "templates"));
  }

  // 2. Fallback if polpoDir is not the default .polpo
  const defaultPolpoDir = join(cwd, ".polpo");
  if (!polpoDir || resolve(polpoDir) !== resolve(defaultPolpoDir)) {
    dirs.push(join(defaultPolpoDir, "templates"));
  }

  // 3. User-level: ~/.polpo/templates/
  dirs.push(join(homedir(), ".polpo", "templates"));

  for (const dir of dirs) {
    for (const tpl of scanTemplateDir(dir)) {
      if (!seen.has(tpl.name)) {
        seen.add(tpl.name);
        results.push(tpl);
      }
    }
  }

  return results;
}

/**
 * Load a full template definition by name.
 * Returns null if not found.
 */
export function loadTemplate(cwd: string, polpoDir: string | undefined, name: string): TemplateDefinition | null {
  const templates = discoverTemplates(cwd, polpoDir);
  const info = templates.find(t => t.name === name);
  if (!info) return null;

  const templateFile = join(info.path, "template.json");
  try {
    const raw = readFileSync(templateFile, "utf-8");
    return JSON.parse(raw) as TemplateDefinition;
  } catch {
    return null;
  }
}

// ── Parameter Validation ───────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** Non-blocking issues (e.g. unknown parameters). */
  warnings: string[];
  /** Resolved params with defaults applied. */
  resolved: Record<string, string | number | boolean>;
}

/**
 * Validate user-provided parameters against the template definition.
 * Applies defaults, checks required fields, types, and enum constraints.
 */
export function validateParams(
  template: TemplateDefinition,
  params: Record<string, string | number | boolean>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: Record<string, string | number | boolean> = {};
  const defs = template.parameters ?? [];

  for (const def of defs) {
    const value = params[def.name];

    if (value === undefined || value === "") {
      if (def.default !== undefined) {
        resolved[def.name] = def.default;
      } else if (def.required) {
        errors.push(`Missing required parameter: ${def.name}`);
      }
      continue;
    }

    // Type coercion & validation
    const expectedType = def.type ?? "string";

    if (expectedType === "number") {
      const num = Number(value);
      if (isNaN(num)) {
        errors.push(`Parameter "${def.name}" must be a number, got: ${value}`);
        continue;
      }
      resolved[def.name] = num;
    } else if (expectedType === "boolean") {
      if (typeof value === "boolean") {
        resolved[def.name] = value;
      } else {
        const str = String(value).toLowerCase();
        if (str === "true" || str === "1" || str === "yes") {
          resolved[def.name] = true;
        } else if (str === "false" || str === "0" || str === "no") {
          resolved[def.name] = false;
        } else {
          errors.push(`Parameter "${def.name}" must be a boolean, got: ${value}`);
          continue;
        }
      }
    } else {
      resolved[def.name] = String(value);
    }

    // Enum check
    if (def.enum && def.enum.length > 0) {
      if (!def.enum.includes(resolved[def.name] as string | number)) {
        errors.push(`Parameter "${def.name}" must be one of: ${def.enum.join(", ")}. Got: ${resolved[def.name]}`);
      }
    }
  }

  // Warn about unknown parameters (non-blocking)
  for (const key of Object.keys(params)) {
    if (!defs.some(d => d.name === key)) {
      warnings.push(`Unknown parameter: ${key}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings, resolved };
}

// ── Instantiation ──────────────────────────────────────────────────────

/**
 * Instantiate a template with resolved parameters.
 *
 * 1. Serializes the mission to JSON string
 * 2. Replaces all {{placeholder}} with parameter values
 * 3. Re-parses the JSON to validate structural integrity
 * 4. Returns the mission data string ready for missionExecutor.saveMission()
 */
export function instantiateTemplate(
  template: TemplateDefinition,
  resolved: Record<string, string | number | boolean>,
): { name: string; data: string; prompt: string } {
  let json = JSON.stringify(template.mission);

  // Replace all {{param}} placeholders
  for (const [key, value] of Object.entries(resolved)) {
    const placeholder = `{{${key}}}`;
    // Use split+join for global replace (avoids regex special chars)
    json = json.split(placeholder).join(String(value));
  }

  // Check for unreplaced placeholders
  const unreplaced = json.match(/\{\{([^}]+)\}\}/g);
  if (unreplaced) {
    const names = [...new Set(unreplaced.map(m => m.slice(2, -2)))];
    throw new Error(`Unreplaced placeholders in template "${template.name}": ${names.join(", ")}`);
  }

  // Validate the resulting JSON is still valid
  try {
    JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Template "${template.name}" produced invalid JSON after parameter substitution: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Build a human-readable prompt describing what was executed
  const paramDesc = Object.entries(resolved)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const prompt = `template:${template.name}${paramDesc ? ` (${paramDesc})` : ""}`;

  return { name: template.name, data: json, prompt };
}

// ── Persistence ────────────────────────────────────────────────────────

/**
 * Validate a template definition object structurally.
 * Returns an array of error strings (empty = valid).
 */
export function validateTemplateDefinition(def: Partial<TemplateDefinition>): string[] {
  const errors: string[] = [];

  if (!def.name || typeof def.name !== "string") {
    errors.push("Missing or invalid 'name' (must be a non-empty string).");
  } else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(def.name)) {
    errors.push(`Invalid name "${def.name}" — must be kebab-case (e.g. "bug-fix", "code-review").`);
  }

  if (!def.description || typeof def.description !== "string") {
    errors.push("Missing or invalid 'description' (must be a non-empty string).");
  }

  if (!def.mission || typeof def.mission !== "object") {
    errors.push("Missing or invalid 'mission' (must be an object).");
  }

  if (def.parameters !== undefined) {
    if (!Array.isArray(def.parameters)) {
      errors.push("'parameters' must be an array if provided.");
    } else {
      for (const [i, p] of def.parameters.entries()) {
        if (!p.name || typeof p.name !== "string") {
          errors.push(`Parameter [${i}]: missing or invalid 'name'.`);
        }
        if (!p.description || typeof p.description !== "string") {
          errors.push(`Parameter [${i}]: missing or invalid 'description'.`);
        }
        if (p.type && !["string", "number", "boolean"].includes(p.type)) {
          errors.push(`Parameter [${i}]: invalid type "${p.type}" (must be string|number|boolean).`);
        }
      }
    }
  }

  // Check that all placeholders in the mission have matching parameter declarations
  if (def.mission && typeof def.mission === "object" && def.parameters) {
    const json = JSON.stringify(def.mission);
    const placeholders = json.match(/\{\{([^}]+)\}\}/g);
    if (placeholders) {
      const usedNames = new Set(placeholders.map(m => m.slice(2, -2)));
      const declaredNames = new Set(def.parameters.map(p => p.name));
      for (const name of usedNames) {
        if (!declaredNames.has(name)) {
          errors.push(`Placeholder "{{${name}}}" in mission has no matching parameter declaration.`);
        }
      }

      // Check that optional params without defaults don't have placeholders in the mission.
      // If they do, omitting the param at runtime would leave the placeholder unreplaced and crash.
      for (const p of def.parameters) {
        if (!p.required && p.default === undefined && usedNames.has(p.name)) {
          errors.push(
            `Parameter "${p.name}" is optional with no default but is used as "{{${p.name}}}" in the mission. ` +
            `Either mark it as required, provide a default value, or remove the placeholder.`,
          );
        }
      }
    }
  }

  return errors;
}

/**
 * Save a template to disk.
 *
 * Creates/overwrites `<polpoDir>/templates/<name>/template.json`.
 * Validates the definition structure before writing.
 *
 * @returns The absolute path to the saved template directory.
 * @throws If validation fails or the write fails.
 */
export function saveTemplate(polpoDir: string, definition: TemplateDefinition): string {
  const errors = validateTemplateDefinition(definition);
  if (errors.length > 0) {
    throw new Error(`Invalid template definition:\n  - ${errors.join("\n  - ")}`);
  }

  const templateDir = join(polpoDir, "templates", definition.name);
  mkdirSync(templateDir, { recursive: true });

  const templateFile = join(templateDir, "template.json");
  writeFileSync(templateFile, JSON.stringify(definition, null, 2), "utf-8");

  return templateDir;
}

/**
 * Delete a template from disk.
 *
 * Removes the `<polpoDir>/templates/<name>/` directory entirely.
 * Also checks `~/.polpo/templates/<name>/` if not found in polpoDir.
 *
 * @returns true if deleted, false if not found.
 */
export function deleteTemplate(cwd: string, polpoDir: string | undefined, name: string): boolean {
  // Find where the template lives
  const templates = discoverTemplates(cwd, polpoDir);
  const info = templates.find(t => t.name === name);
  if (!info) return false;

  rmSync(info.path, { recursive: true, force: true });
  return true;
}
