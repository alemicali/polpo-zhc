import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

/**
 * Persist an env var to the .polpo/.env file (upsert semantics).
 */
export function persistToEnvFile(polpoDir: string, envVar: string, value: string): void {
  const envPath = join(polpoDir, ".env");
  if (!existsSync(polpoDir)) mkdirSync(polpoDir, { recursive: true });

  let content = "";
  if (existsSync(envPath)) {
    content = readFileSync(envPath, "utf-8");
    const regex = new RegExp(`^${envVar}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${envVar}=${value}`);
      writeFileSync(envPath, content, "utf-8");
      try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
      return;
    }
  }

  const line = `${envVar}=${value}\n`;
  writeFileSync(envPath, content ? `${content.trimEnd()}\n${line}` : line, "utf-8");
  try { chmodSync(envPath, 0o600); } catch { /* best-effort */ }
}

/**
 * Remove an env var from the .polpo/.env file.
 */
export function removeFromEnvFile(polpoDir: string, envVar: string): void {
  const envPath = join(polpoDir, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  const updated = content.replace(new RegExp(`^${envVar}=.*\\n?`, "m"), "");
  writeFileSync(envPath, updated, "utf-8");
}
