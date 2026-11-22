import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-member dashboard preferences ("where I was" in the chat), stored at
 * `<polpoDir>/member-preferences.json` so they follow the person across
 * devices. Keyed by the signed-in member's email; without instance auth
 * (single-user installs, API-key clients) everything lives under one
 * shared key.
 *
 * Only navigation state lives here — never message content or drafts.
 */
export interface ChatNavigationPreferences {
  /** Thread open in the chat; null = a new, unsaved chat. */
  lastSessionId?: string | null;
  /** Group open in the chat (wins over lastSessionId), or null. */
  lastRoomId?: string | null;
  /** Agent picked for the new chat when lastSessionId is null. */
  lastAgent?: string | null;
  /** Thread ids open as tabs, left to right. */
  openTabs?: string[];
  /** Right-hand chat panel shown on other pages. */
  sidePanelOpen?: boolean;
  /** Thread list (session sidebar) shown next to the chat. */
  threadsOpen?: boolean;
  /** When the preferences were last written (set by the server). */
  updatedAt?: string;
}

export interface MemberPreferences {
  chatNavigation?: ChatNavigationPreferences;
}

export type MemberPreferencesPatch = {
  chatNavigation?: Omit<ChatNavigationPreferences, "updatedAt">;
};

interface PreferencesFile {
  version: 1;
  members: Record<string, MemberPreferences>;
}

const FILE_NAME = "member-preferences.json";
/** Key used when there is no signed-in member (auth disabled, API key). */
export const SHARED_MEMBER_KEY = "_shared";
const MAX_MEMBERS = 500;
const MAX_TABS = 50;

export function memberKey(email: string | undefined | null): string {
  const normalized = email?.trim().toLowerCase();
  return normalized ? normalized : SHARED_MEMBER_KEY;
}

function filePath(polpoDir: string): string {
  return join(polpoDir, FILE_NAME);
}

function readFile(polpoDir: string): PreferencesFile {
  const file = filePath(polpoDir);
  if (!existsSync(file)) return { version: 1, members: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<PreferencesFile>;
    const members = parsed && typeof parsed.members === "object" && parsed.members ? parsed.members : {};
    return { version: 1, members: members as Record<string, MemberPreferences> };
  } catch {
    return { version: 1, members: {} };
  }
}

function writeFile(polpoDir: string, data: PreferencesFile): void {
  mkdirSync(polpoDir, { recursive: true });
  const file = filePath(polpoDir);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, file);
}

export function readMemberPreferences(polpoDir: string, member: string): MemberPreferences {
  return readFile(polpoDir).members[member] ?? {};
}

function normalizeChatNavigation(input: ChatNavigationPreferences): ChatNavigationPreferences {
  const out: ChatNavigationPreferences = {};
  if (input.lastSessionId !== undefined) out.lastSessionId = input.lastSessionId;
  if (input.lastRoomId !== undefined) out.lastRoomId = input.lastRoomId;
  if (input.lastAgent !== undefined) out.lastAgent = input.lastAgent;
  if (input.openTabs !== undefined) out.openTabs = [...new Set(input.openTabs)].slice(-MAX_TABS);
  if (input.sidePanelOpen !== undefined) out.sidePanelOpen = input.sidePanelOpen;
  if (input.threadsOpen !== undefined) out.threadsOpen = input.threadsOpen;
  if (input.updatedAt !== undefined) out.updatedAt = input.updatedAt;
  return out;
}

/** Merge `patch` into the member's preferences (per section, field by field) and persist. */
export function updateMemberPreferences(
  polpoDir: string,
  member: string,
  patch: MemberPreferencesPatch,
  now: () => Date = () => new Date(),
): MemberPreferences {
  const data = readFile(polpoDir);
  const current = data.members[member] ?? {};
  const next: MemberPreferences = { ...current };
  if (patch.chatNavigation) {
    next.chatNavigation = normalizeChatNavigation({
      ...(current.chatNavigation ?? {}),
      ...patch.chatNavigation,
      updatedAt: now().toISOString(),
    });
  }
  // Re-insert so the most recently written member is last; drop the oldest past the cap.
  delete data.members[member];
  data.members[member] = next;
  const keys = Object.keys(data.members);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_MEMBERS))) delete data.members[key];
  writeFile(polpoDir, data);
  return next;
}
