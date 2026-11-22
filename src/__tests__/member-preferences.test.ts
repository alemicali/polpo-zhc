import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { preferencesRoutes } from "../server/routes/preferences.js";

let dir: string;
let signedIn: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-prefs-"));
  signedIn = undefined;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const app = () => preferencesRoutes({ polpoDir: () => dir, member: () => signedIn });
const patch = (body: unknown) => app().request("/", {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const get = async () => (await (await app().request("/")).json()) as any;

test("chat navigation preferences are stored per member and merged field by field", async () => {
  signedIn = "Ale@Polpo.sh";
  expect((await get()).data).toEqual({ member: "ale@polpo.sh", preferences: {} });

  let res = await patch({ chatNavigation: { lastSessionId: "s1", openTabs: ["s1", "s2"], sidePanelOpen: true } });
  expect(res.status).toBe(200);
  res = await patch({ chatNavigation: { lastSessionId: null, lastAgent: "giulia" } });
  const body = await res.json() as any;
  expect(body.data.preferences.chatNavigation).toMatchObject({
    lastSessionId: null, lastAgent: "giulia", openTabs: ["s1", "s2"], sidePanelOpen: true,
  });
  expect(typeof body.data.preferences.chatNavigation.updatedAt).toBe("string");

  // Another member has their own preferences.
  signedIn = "marco@polpo.sh";
  expect((await get()).data.preferences).toEqual({});
  await patch({ chatNavigation: { lastRoomId: "web:1" } });
  signedIn = "ale@polpo.sh";
  expect((await get()).data.preferences.chatNavigation.lastRoomId).toBeUndefined();

  // Without instance auth everything lives under one shared key.
  signedIn = undefined;
  await patch({ chatNavigation: { threadsOpen: true } });
  expect((await get()).data).toMatchObject({ member: null, preferences: { chatNavigation: { threadsOpen: true } } });

  const file = join(dir, "member-preferences.json");
  expect(Object.keys(JSON.parse(readFileSync(file, "utf-8")).members).sort()).toEqual(["_shared", "ale@polpo.sh", "marco@polpo.sh"]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("preferences reject unknown fields and oversized tab lists", async () => {
  expect((await patch({ chatNavigation: { lastSessionId: "s1", message: "secret" } })).status).toBe(400);
  expect((await patch({ chatNavigation: { openTabs: Array.from({ length: 51 }, (_, i) => `s${i}`) } })).status).toBe(400);
  expect((await patch({ other: true })).status).toBe(400);
  expect((await app().request("/")).headers.get("cache-control")).toBe("no-store");
});
