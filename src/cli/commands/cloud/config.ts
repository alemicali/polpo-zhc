/**
 * Credential storage for the polpo-cloud CLI.
 *
 * Reads/writes credentials to ~/.polpo/credentials.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_DIR = path.join(os.homedir(), ".polpo");
const CREDENTIALS_FILE = path.join(CONFIG_DIR, "credentials.json");

const DEFAULT_BASE_URL = "https://api.polpo.sh";

export interface Credentials {
  apiKey: string;
  baseUrl: string;
  projectId?: string;
}

export function saveCredentials(
  apiKey: string,
  baseUrl?: string,
  projectId?: string,
): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  const creds: Credentials = {
    apiKey,
    baseUrl: baseUrl ?? DEFAULT_BASE_URL,
    ...(projectId ? { projectId } : {}),
  };

  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), "utf-8");
}

export function loadCredentials(): Credentials | null {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.apiKey || !parsed.baseUrl) return null;
    return parsed as Credentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
  }
}
