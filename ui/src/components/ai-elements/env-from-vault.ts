export interface EnvFromVaultRef {
  name: string;
  ref: string;
}

/**
 * The vault references of a bash call's env_from_vault ({ VAR: "service.key" | { service, key } }).
 * Only references: the values never reach the browser.
 */
export function envFromVaultRefs(args: Record<string, unknown> | undefined): EnvFromVaultRef[] {
  const spec = args?.env_from_vault;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return [];
  const out: EnvFromVaultRef[] = [];
  for (const [name, value] of Object.entries(spec as Record<string, unknown>)) {
    if (typeof value === "string") out.push({ name, ref: value });
    else if (value && typeof value === "object") {
      const { service, key } = value as { service?: unknown; key?: unknown };
      if (typeof service === "string" && typeof key === "string") out.push({ name, ref: `${service}.${key}` });
    }
  }
  return out;
}
