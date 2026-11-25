/**
 * Server settings: non-secret, typed values (a store id, a default currency) that a spec declares in
 * `settingsSchema` and templates use as `{{settings.key}}`. The values are set at install and can be
 * changed later without a new version (they live in the server's meta, not in the spec).
 */
import type { McpServerSettingField, McpServerSettingValues } from "./types.js";

export const SETTING_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const TYPES = new Set(["string", "number", "enum", "boolean"]);

export class McpSettingsError extends Error {
  constructor(message: string, readonly problems: string[]) { super(message); }
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Normalize a declared schema (shape errors throw; used by normalizeSpec). */
export function normalizeSettingsSchema(input: unknown): McpServerSettingField[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("settingsSchema must be a list of { key, label, type }");
  const seen = new Set<string>();
  return input.map((raw, i) => {
    if (!obj(raw)) throw new Error(`settingsSchema[${i}] must be an object`);
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    if (!SETTING_KEY_PATTERN.test(key)) throw new Error(`settingsSchema[${i}].key must be letters, digits and _`);
    if (seen.has(key)) throw new Error(`settingsSchema: "${key}" is declared twice`);
    seen.add(key);
    const type = typeof raw.type === "string" && TYPES.has(raw.type) ? raw.type as McpServerSettingField["type"] : "string";
    const options = Array.isArray(raw.options) ? raw.options.filter((o): o is string => typeof o === "string" && o !== "") : undefined;
    if (type === "enum" && !options?.length) throw new Error(`settingsSchema.${key}: an enum needs options`);
    if (typeof raw.pattern === "string") { try { new RegExp(raw.pattern); } catch { throw new Error(`settingsSchema.${key}: pattern is not a regular expression`); } }
    const def = raw.default;
    return {
      key,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim().slice(0, 100) : key,
      type,
      ...(typeof raw.help === "string" && raw.help.trim() ? { help: raw.help.trim().slice(0, 1000) } : {}),
      ...(raw.required === true ? { required: true } : {}),
      ...(typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? { default: def } : {}),
      ...(options?.length ? { options } : {}),
      ...(typeof raw.pattern === "string" && raw.pattern ? { pattern: raw.pattern } : {}),
      ...(typeof raw.min === "number" ? { min: raw.min } : {}),
      ...(typeof raw.max === "number" ? { max: raw.max } : {}),
    };
  });
}

/** One value against its field: the coerced value, or a problem. */
function coerce(field: McpServerSettingField, value: unknown): { value?: string | number | boolean; problem?: string } {
  const label = `${field.label} (${field.key})`;
  switch (field.type) {
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (!Number.isFinite(n)) return { problem: `${label} must be a number` };
      if (field.min !== undefined && n < field.min) return { problem: `${label} must be at least ${field.min}` };
      if (field.max !== undefined && n > field.max) return { problem: `${label} must be at most ${field.max}` };
      return { value: n };
    }
    case "boolean": {
      if (typeof value === "boolean") return { value };
      if (value === "true" || value === "false") return { value: value === "true" };
      return { problem: `${label} must be true or false` };
    }
    case "enum": {
      const s = String(value);
      if (!field.options?.includes(s)) return { problem: `${label} must be one of ${field.options?.join(", ")}` };
      return { value: s };
    }
    default: {
      if (typeof value !== "string" && typeof value !== "number") return { problem: `${label} must be text` };
      const s = String(value).trim();
      if (s.length > 500) return { problem: `${label} is longer than 500 characters` };
      if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(s)) return { problem: `${label} does not have the expected format` };
      return { value: s };
    }
  }
}

/**
 * Validate values against a schema. Unknown keys are refused; empty values clear the key; required
 * fields with no value and no default are problems. Returns only the values that were set.
 */
export function validateSettings(schema: McpServerSettingField[] | undefined, values: unknown): { values: McpServerSettingValues; problems: string[] } {
  const fields = schema ?? [];
  const problems: string[] = [];
  const out: McpServerSettingValues = {};
  const input = obj(values) ? values : {};
  if (values !== undefined && values !== null && !obj(values)) problems.push("settings must be an object: key → value");
  for (const key of Object.keys(input)) if (!fields.some((f) => f.key === key)) problems.push(`"${key}" is not a setting of this server`);
  for (const field of fields) {
    const v = input[field.key];
    if (v === undefined || v === null || v === "") {
      if (field.required && field.default === undefined) problems.push(`${field.label} (${field.key}) is required`);
      continue;
    }
    const r = coerce(field, v);
    if (r.problem) problems.push(r.problem);
    else out[field.key] = r.value!;
  }
  return { values: out, problems };
}

/** The values templates see: the stored ones over the defaults. */
export function effectiveSettings(schema: McpServerSettingField[] | undefined, stored: McpServerSettingValues | undefined): McpServerSettingValues {
  const out: McpServerSettingValues = {};
  for (const field of schema ?? []) {
    const v = stored?.[field.key];
    if (v !== undefined && v !== "") out[field.key] = v;
    else if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
}

/** Settings the spec requires that have no value (stored or default). */
export function missingSettings(schema: McpServerSettingField[] | undefined, stored: McpServerSettingValues | undefined): string[] {
  const eff = effectiveSettings(schema, stored);
  return (schema ?? []).filter((f) => f.required && (eff[f.key] === undefined || eff[f.key] === "")).map((f) => f.key);
}
