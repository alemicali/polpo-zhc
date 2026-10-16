/**
 * Minimal JSON Schema validation for loop output contracts (`output.schema`).
 *
 * Supports the subset used to describe structured agent output:
 * type (string or array), properties, required, additionalProperties (boolean),
 * items, enum, const, minLength/maxLength, minimum/maximum, minItems/maxItems.
 * Unknown keywords are ignored, so a richer schema still validates its core shape.
 */

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate `value` against `schema`. Returns a list of errors (empty when valid). */
export function validateSchema(value: unknown, schema: unknown, path = "$"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Schema;
  const errors: string[] = [];

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      return [`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`];
    }
  }

  if (Array.isArray(s.enum) && !s.enum.some((e) => sameValue(e, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  }
  if ("const" in s && !sameValue(s.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  }

  if (typeof value === "string") {
    if (typeof s.minLength === "number" && value.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === "number" && value.length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
  }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) errors.push(`${path}: above maximum ${s.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    if (s.items && typeof s.items === "object") {
      value.forEach((item, i) => errors.push(...validateSchema(item, s.items, `${path}[${i}]`)));
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (s.properties && typeof s.properties === "object") ? (s.properties as Record<string, unknown>) : {};
    if (Array.isArray(s.required)) {
      for (const key of s.required as string[]) {
        if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key}: is required`);
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) errors.push(...validateSchema(obj[key], propSchema, `${path}.${key}`));
    }
    if (s.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}.${key}: is not allowed`);
      }
    }
  }

  return errors;
}
