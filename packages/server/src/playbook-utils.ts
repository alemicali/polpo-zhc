/**
 * Playbook validation and instantiation utilities.
 * Pure logic — no Node.js deps, edge-compatible.
 *
 * Extracted from src/core/playbook.ts (which has node:fs for file-based loading).
 */

export interface PlaybookParameter {
  name: string;
  description: string;
  type?: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
  enum?: (string | number)[];
}

export interface PlaybookDefinition {
  name: string;
  description: string;
  mission: Record<string, unknown>;
  parameters?: PlaybookParameter[];
  version?: string;
  author?: string;
  tags?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  resolved: Record<string, string | number | boolean>;
}

export function validateParams(
  playbook: PlaybookDefinition,
  params: Record<string, string | number | boolean>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: Record<string, string | number | boolean> = {};
  const defs = playbook.parameters ?? [];

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
    const expectedType = def.type ?? "string";
    if (expectedType === "number") {
      const num = Number(value);
      if (isNaN(num)) { errors.push(`Parameter "${def.name}" must be a number, got: ${value}`); continue; }
      resolved[def.name] = num;
    } else if (expectedType === "boolean") {
      if (typeof value === "boolean") { resolved[def.name] = value; }
      else {
        const str = String(value).toLowerCase();
        if (str === "true" || str === "1" || str === "yes") resolved[def.name] = true;
        else if (str === "false" || str === "0" || str === "no") resolved[def.name] = false;
        else { errors.push(`Parameter "${def.name}" must be a boolean, got: ${value}`); continue; }
      }
    } else {
      resolved[def.name] = String(value);
    }
    if (def.enum && def.enum.length > 0 && !def.enum.includes(resolved[def.name] as string | number)) {
      errors.push(`Parameter "${def.name}" must be one of: ${def.enum.join(", ")}. Got: ${resolved[def.name]}`);
    }
  }
  for (const key of Object.keys(params)) {
    if (!defs.some(d => d.name === key)) warnings.push(`Unknown parameter: ${key}`);
  }
  return { valid: errors.length === 0, errors, warnings, resolved };
}

export function instantiatePlaybook(
  playbook: PlaybookDefinition,
  resolved: Record<string, string | number | boolean>,
): { name: string; data: string; prompt: string } {
  let json = JSON.stringify(playbook.mission);
  for (const [key, value] of Object.entries(resolved)) {
    json = json.split(`{{${key}}}`).join(String(value));
  }
  const unreplaced = json.match(/\{\{([^}]+)\}\}/g);
  if (unreplaced) {
    const names = [...new Set(unreplaced.map(m => m.slice(2, -2)))];
    throw new Error(`Unreplaced placeholders in playbook "${playbook.name}": ${names.join(", ")}`);
  }
  try { JSON.parse(json); } catch (err) {
    throw new Error(`Playbook "${playbook.name}" produced invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const paramDesc = Object.entries(resolved).map(([k, v]) => `${k}=${v}`).join(", ");
  return { name: playbook.name, data: json, prompt: `playbook:${playbook.name}${paramDesc ? ` (${paramDesc})` : ""}` };
}
