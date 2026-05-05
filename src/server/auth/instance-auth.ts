import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MagicLinkRecord {
  email: string;
  tokenHash: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

export interface SessionRecord {
  email: string;
  sessionHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface InstanceAuthConfig {
  enabled: boolean;
  allowedEmails: string[];
  magicLinks: MagicLinkRecord[];
  sessions: SessionRecord[];
  createdAt: string;
  updatedAt: string;
}

const AUTH_FILE = "auth.json";
const DEFAULT_MAGIC_LINK_TTL_MS = 10 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const AUTH_COOKIE_NAME = "polpo_session";

export function isInstanceAuthEnabled(): boolean {
  const value = process.env.POLPO_AUTH_ENABLED;
  return value === "1" || value?.toLowerCase() === "true";
}

export function getAuthFilePath(polpoDir: string): string {
  return join(polpoDir, AUTH_FILE);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "s") return amount * 1000;
  return amount;
}

export function getMagicLinkTtlMs(): number {
  return parseDurationMs(process.env.POLPO_AUTH_MAGIC_LINK_TTL, DEFAULT_MAGIC_LINK_TTL_MS);
}

export function getSessionTtlMs(): number {
  return parseDurationMs(process.env.POLPO_AUTH_SESSION_TTL, DEFAULT_SESSION_TTL_MS);
}

export function loadInstanceAuth(polpoDir: string): InstanceAuthConfig | null {
  const file = getAuthFilePath(polpoDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<InstanceAuthConfig>;
    return {
      enabled: parsed.enabled ?? true,
      allowedEmails: (parsed.allowedEmails ?? []).map(normalizeEmail).filter(Boolean),
      magicLinks: parsed.magicLinks ?? [],
      sessions: parsed.sessions ?? [],
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

export function saveInstanceAuth(polpoDir: string, config: InstanceAuthConfig): void {
  mkdirSync(polpoDir, { recursive: true });
  writeFileSync(getAuthFilePath(polpoDir), JSON.stringify(config, null, 2));
}

export function createInitialInstanceAuth(polpoDir: string, adminEmail: string): InstanceAuthConfig {
  const now = new Date().toISOString();
  const config: InstanceAuthConfig = {
    enabled: true,
    allowedEmails: [normalizeEmail(adminEmail)],
    magicLinks: [],
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };
  saveInstanceAuth(polpoDir, config);
  return config;
}

export function createMagicLink(polpoDir: string, email: string): { token: string; expiresAt: string } | null {
  const config = loadInstanceAuth(polpoDir);
  const normalized = normalizeEmail(email);
  if (!config?.enabled || !config.allowedEmails.includes(normalized)) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + getMagicLinkTtlMs()).toISOString();
  const now = new Date().toISOString();
  const activeLinks = config.magicLinks.filter((link) =>
    !link.usedAt && new Date(link.expiresAt).getTime() > Date.now(),
  );
  config.magicLinks = [
    ...activeLinks,
    {
      email: normalized,
      tokenHash: hashToken(token),
      expiresAt,
      createdAt: now,
    },
  ];
  config.updatedAt = now;
  saveInstanceAuth(polpoDir, config);
  return { token, expiresAt };
}

export function consumeMagicLink(polpoDir: string, token: string): { sessionToken: string; email: string; expiresAt: string } | null {
  const config = loadInstanceAuth(polpoDir);
  if (!config?.enabled) return null;

  const tokenHash = hashToken(token);
  const nowMs = Date.now();
  const link = config.magicLinks.find((record) =>
    !record.usedAt &&
    new Date(record.expiresAt).getTime() > nowMs &&
    safeCompare(record.tokenHash, tokenHash),
  );
  if (!link) return null;

  link.usedAt = new Date(nowMs).toISOString();
  const sessionToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(nowMs + getSessionTtlMs()).toISOString();
  config.sessions = [
    ...config.sessions.filter((session) => new Date(session.expiresAt).getTime() > nowMs),
    {
      email: link.email,
      sessionHash: hashToken(sessionToken),
      expiresAt,
      createdAt: new Date(nowMs).toISOString(),
    },
  ];
  config.updatedAt = new Date(nowMs).toISOString();
  saveInstanceAuth(polpoDir, config);
  return { sessionToken, email: link.email, expiresAt };
}

export function validateSession(polpoDir: string, sessionToken: string | undefined): { email: string } | null {
  if (!sessionToken) return null;
  const config = loadInstanceAuth(polpoDir);
  if (!config?.enabled) return null;
  const sessionHash = hashToken(sessionToken);
  const now = Date.now();
  const session = config.sessions.find((record) =>
    new Date(record.expiresAt).getTime() > now &&
    safeCompare(record.sessionHash, sessionHash),
  );
  return session ? { email: session.email } : null;
}

export function clearSession(polpoDir: string, sessionToken: string | undefined): void {
  if (!sessionToken) return;
  const config = loadInstanceAuth(polpoDir);
  if (!config) return;
  const sessionHash = hashToken(sessionToken);
  config.sessions = config.sessions.filter((record) => !safeCompare(record.sessionHash, sessionHash));
  config.updatedAt = new Date().toISOString();
  saveInstanceAuth(polpoDir, config);
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
