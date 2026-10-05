import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { readAvatar, syncTelegramBotProfile, toProfileJpeg } from "../notifications/telegram-bot-profile.js";

let dir: string;
const png = (r: number) => sharp({ create: { width: 32, height: 32, channels: 3, background: { r, g: 10, b: 10 } } }).png().toBuffer();

function okFetch() {
  return vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: true })));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-bot-profile-"));
  mkdirSync(join(dir, "workspace", ".polpo", "avatars"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const agent = (avatar?: string) => ({
  name: "health-coach",
  role: "Coach",
  identity: { avatar, bio: "Alessio's personal health coach.", title: "Personal Health & Wellness Coach" },
});

function sync(fetchImpl: typeof fetch, avatar = ".polpo/avatars/health-coach.png") {
  return syncTelegramBotProfile({
    botToken: "123:abc",
    agent: agent(avatar),
    roots: [dir, join(dir, "workspace")],
    statePath: join(dir, "profiles.json"),
    fetch: fetchImpl,
  });
}

describe("readAvatar / toProfileJpeg", () => {
  it("finds the avatar under any root and reads raw or base64-encoded files", async () => {
    const image = await png(200);
    writeFileSync(join(dir, "workspace", ".polpo", "avatars", "raw.png"), image);
    writeFileSync(join(dir, "workspace", ".polpo", "avatars", "b64.png"), image.toString("base64"));
    const roots = [dir, join(dir, "workspace")];

    expect(readAvatar(".polpo/avatars/raw.png", roots)?.equals(image)).toBe(true);
    expect(readAvatar(".polpo/avatars/b64.png", roots)?.equals(image)).toBe(true);
    expect(readAvatar(".polpo/avatars/missing.png", roots)).toBeUndefined();
  });

  it("produces a 640x640 JPEG", async () => {
    const meta = await sharp(await toProfileJpeg(await png(50))).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 640, 640]);
  });
});

describe("syncTelegramBotProfile", () => {
  it("uploads photo and descriptions the first time, then nothing while unchanged", async () => {
    writeFileSync(join(dir, "workspace", ".polpo", "avatars", "health-coach.png"), await png(100));
    const fetchImpl = okFetch();

    expect(await sync(fetchImpl)).toEqual({ photo: "updated", description: "updated" });
    const methods = fetchImpl.mock.calls.map(([url]) => String(url).split("/").pop());
    expect(methods).toEqual(["setMyDescription", "setMyShortDescription", "setMyProfilePhoto"]);

    const photoCall = fetchImpl.mock.calls[2][1];
    const form = photoCall.body as FormData;
    expect(JSON.parse(form.get("photo") as string)).toEqual({ type: "static", photo: "attach://avatar" });
    expect((form.get("avatar") as Blob).type).toBe("image/jpeg");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ short_description: "Personal Health & Wellness Coach" });

    fetchImpl.mockClear();
    expect(await sync(fetchImpl)).toEqual({ photo: "unchanged", description: "unchanged" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-uploads only the photo when the avatar changes", async () => {
    const file = join(dir, "workspace", ".polpo", "avatars", "health-coach.png");
    writeFileSync(file, await png(100));
    await sync(okFetch());

    writeFileSync(file, await png(220));
    const fetchImpl = okFetch();
    expect(await sync(fetchImpl)).toEqual({ photo: "updated", description: "unchanged" });
    expect(fetchImpl.mock.calls.map(([url]) => String(url).split("/").pop())).toEqual(["setMyProfilePhoto"]);
  });

  it("reports a missing avatar and retries a failed upload next time", async () => {
    expect((await sync(okFetch(), ".polpo/avatars/none.png")).photo).toBe("missing");

    writeFileSync(join(dir, "workspace", ".polpo", "avatars", "health-coach.png"), await png(100));
    const failing = vi.fn().mockImplementation(async (url: string) => new Response(JSON.stringify(
      String(url).endsWith("setMyProfilePhoto") ? { ok: false, description: "PHOTO_INVALID" } : { ok: true, result: true },
    )));
    const failed = await sync(failing);
    expect(failed.photo).toBe("failed");
    expect(failed.error).toContain("PHOTO_INVALID");

    const retry = okFetch();
    expect((await sync(retry)).photo).toBe("updated");
  });
});

describe("syncTelegramBotProfile — shared state file", () => {
  it("keeps every bot's entry when several bots sync concurrently", async () => {
    const statePath = join(dir, "profiles.json");
    const run = (botToken: string) => syncTelegramBotProfile({ botToken, agent: agent(), roots: [dir], statePath, fetch: okFetch() });
    await Promise.all([run("1:a"), run("2:b"), run("3:c")]);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(Object.keys(state)).toHaveLength(3);
  });
});
