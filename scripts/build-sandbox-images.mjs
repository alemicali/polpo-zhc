#!/usr/bin/env node
/**
 * Build the Polpo runner image for the remote sandbox providers (like open Polpo's
 * docker/runner/Dockerfile): the tools agents use in a VM are preinstalled, so nothing is
 * downloaded at run time.
 *
 *   - agent-browser + Google Chrome (vm-4; agents' browsers are real Chrome, never Chromium: sites
 *     flag Chromium as a bot), agent-browser's Chromium with every shared library it needs, and
 *     fonts; playwright-core (pdf_create renders HTML with that Chromium, in the VM)
 *   - mountpoint-s3, rclone and FUSE (storage mounts)
 *   - tailscale + tailscaled (a pinned release, checksum checked): computers whose browser goes out
 *     through a tailnet-only egress proxy join the tailnet from inside the VM
 *   - git, curl, python3 (+ edge-tts), poppler-utils, sudo, node 22
 *   - a desktop for the live view and "take control" (vm-4): Xvfb + an XFCE session (panel, menu,
 *     Thunar, xfce4-terminal, Mousepad, task manager; no goodies, no screensaver, no power manager),
 *     x11vnc, websockify, xdotool, xclip/xsel, locales it_IT.UTF-8 and en_US.UTF-8, tzdata
 *   - pnpm (PNPM_VERSION, activated with corepack): agent harnesses (Claude Code, Codex) install
 *     their bridge with `pnpm install --frozen-lockfile` (lockfile v9 + allowBuilds: pnpm 10). Polpo
 *     activates it at run time when an older image lacks it (src/adapters/harness-engine.ts).
 *
 * Daytona v0: a snapshot built from the SDK's declarative Image, named "polpo-runner-<version>".
 * Daytona v2: an image (Linux VM) built with the 2.x SDK's ImageBuilder in the project the key
 *   belongs to, named DAYTONA_V2_IMAGE ("polpo-runner-vm-<recipe revision>", the default of
 *   providers.daytona.image when api is "v2": nothing to set when you keep that name).
 * E2B: a template built with the SDK's Template builder, named "polpo-runner-<version with dashes>".
 *
 * Idempotent: an image that already exists (and is usable) is left alone; --force rebuilds it.
 * Then set, per instance, settings.sandbox.providers.daytona.snapshot (v0) / .e2b.template to the
 * name.
 *
 * Keys come from the environment (DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_TARGET for v0;
 * DAYTONA_V2_API_KEY, a v2 project API key, and optionally DAYTONA_V2_REGION for v2; E2B_API_KEY,
 * E2B_DOMAIN) or from --env-file <path> (KEY=value lines). They are never printed.
 *
 *   node scripts/build-sandbox-images.mjs [--provider daytona|daytona-v2|e2b|all] [--force] [--env-file f]
 *   node scripts/build-sandbox-images.mjs --dockerfile     # the equivalent Dockerfile, nothing built
 *
 * Daytona v2 only (what switching an instance to v2 needs):
 *   DAYTONA_V2_API_KEY=dtn_... node scripts/build-sandbox-images.mjs --provider daytona-v2
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

export const BASE_IMAGE = "node:22-bookworm-slim";
export const DAYTONA_SNAPSHOT = `polpo-runner-${version}`;
/**
 * Daytona v2 image name: bump the revision when ROOT_STEPS/USER_STEPS/BASE_IMAGE change (Polpo's
 * DAYTONA_V2_RUNNER_IMAGE in packages/core/src/sandbox.ts must match; a test checks it). A named
 * v2 image with other contents cannot be rebuilt under the same name.
 */
export const DAYTONA_V2_IMAGE = "polpo-runner-vm-4";
/** pnpm for agent harness bootstraps (src/adapters/harness-engine.ts HARNESS_PNPM_VERSION must match; a test checks it). */
export const PNPM_VERSION = "10.30.1";
export const E2B_TEMPLATE = `polpo-runner-${version.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

/**
 * The desktop (src/sandbox/desktop.ts: DESKTOP_VIEW_PACKAGES, DESKTOP_XFCE_PACKAGES and
 * DESKTOP_XFCE_EXTRA_PACKAGES; openbox is only the fallback of VMs where XFCE cannot be installed).
 */
export const DESKTOP_PACKAGES = [
  "xvfb", "x11-xkb-utils", "x11-xserver-utils", "xclip", "xsel", "x11vnc", "websockify", "xdotool",
  "xfce4", "xfce4-terminal", "thunar", "mousepad", "xfce4-taskmanager", "dbus-x11",
  "at-spi2-core", "fonts-dejavu", "fonts-liberation", "tango-icon-theme", "adwaita-icon-theme", "librsvg2-common", "locales", "tzdata",
];

/** Debian packages: baseline tools, PDF text, python for edge-tts, FUSE, every library agent-browser's Chromium links against, fonts. */
const APT_PACKAGES = [
  "git", "curl", "ca-certificates", "sudo", "unzip", "procps", "fuse3", "libfuse2",
  "poppler-utils", "python3", "python3-pip",
  "libnss3", "libnspr4", "libatk1.0-0", "libatk-bridge2.0-0", "libcups2", "libxkbcommon0", "libxcomposite1",
  "libxdamage1", "libxrandr2", "libgbm1", "libxss1", "libasound2", "libpangocairo-1.0-0", "libpango-1.0-0",
  "libcairo2", "libwayland-client0", "libxshmfence1", "libxfixes3", "libxext6", "libxcursor1", "libxi6",
  "libxtst6", "libxrender1", "libxinerama1", "libdbus-1-3", "libatspi2.0-0", "libdrm2", "libx11-xcb1",
  "fonts-liberation", "fonts-dejavu-core", "fonts-noto-color-emoji",
  // the computer's desktop (src/sandbox/desktop.ts DESKTOP_IMAGE_PACKAGES; a test checks they match):
  // a virtual display, a VNC server (password-protected, local only), websockify (what the preview
  // link reaches), the keyboard layout and clipboard tools, and XFCE without recommends
  ...DESKTOP_PACKAGES,
];

/**
 * Tailscale for computers going out through a tailnet-only proxy (src/sandbox/tailnet-egress.ts
 * pins the same release for VMs without it; a test checks they match).
 */
export const TAILSCALE_VERSION = "1.104.7";
export const TAILSCALE_SHA256 = {
  amd64: "e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c",
  arm64: "d6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484",
};
const TAILSCALE_STEP =
  `case "$(uname -m)" in x86_64|amd64) A=amd64; S=${TAILSCALE_SHA256.amd64};; aarch64|arm64) A=arm64; S=${TAILSCALE_SHA256.arm64};; *) echo "unsupported architecture" >&2; exit 1;; esac`
  + ` && F=tailscale_${TAILSCALE_VERSION}_$A && curl -fsSL -o /tmp/ts.tgz "https://pkgs.tailscale.com/stable/$F.tgz"`
  + ` && echo "$S  /tmp/ts.tgz" | sha256sum -c - && tar xzf /tmp/ts.tgz -C /tmp`
  + ` && install -m 755 "/tmp/$F/tailscale" "/tmp/$F/tailscaled" /usr/local/bin/ && rm -rf /tmp/ts.tgz "/tmp/$F" && tailscale version`;

/** Google Chrome from Google's .deb (apt-get pulls its libraries), only when it is not there yet. */
export const CHROME_DEB_URL = "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb";
const CHROME_STEP =
  `command -v google-chrome >/dev/null 2>&1 || { [ "$(dpkg --print-architecture)" = amd64 ] || { echo "Google Chrome needs amd64" >&2; exit 1; }; `
  + `curl -fsSL -o /tmp/google-chrome.deb ${CHROME_DEB_URL} && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/google-chrome.deb `
  + `&& rm -rf /tmp/google-chrome.deb /var/lib/apt/lists/*; } && google-chrome --version`;

/** Steps run as root, in order (shared by both providers and the printed Dockerfile). */
export const ROOT_STEPS = [
  `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")} && rm -rf /var/lib/apt/lists/*`,
  // mountpoint-s3 (S3/R2 FUSE mount), for this machine's architecture
  `ARCH=$(uname -m) && curl -fsSL "https://s3.amazonaws.com/mountpoint-s3-release/latest/$ARCH/mount-s3.deb" -o /tmp/mount-s3.deb && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/mount-s3.deb && rm -rf /tmp/mount-s3.deb /var/lib/apt/lists/*`,
  // rclone (what Polpo mounts granted buckets with)
  "curl -fsSL https://rclone.org/install.sh | bash",
  // tailscale (userspace networking: no TUN, no root needed when it runs)
  TAILSCALE_STEP,
  // edge-tts: free voices for audio_speak (slim Debian is PEP 668 locked)
  "pip install --no-cache-dir --break-system-packages edge-tts",
  // agent-browser CLI (its Chromium is downloaded per user, below, for pdf_create only); playwright-core for pdf_create
  "npm install -g agent-browser playwright-core && npm cache clean --force",
  // Google Chrome (vm-4): the browser agents use (src/tools/agent-chrome.ts installs it the same way in
  // VMs from older images). Google ships Linux builds for amd64 only.
  CHROME_STEP,
  // pnpm 10 for agent harness bootstraps (corepack ships with node 22; pinned, no download prompt)
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@${PNPM_VERSION} --activate && corepack enable pnpm && pnpm --version`,
  "sed -i 's/^# *user_allow_other/user_allow_other/' /etc/fuse.conf || true",
  // the desktop's languages (Italian by default, English): generated once, not at every start
  "sed -i 's/^# *\\(it_IT.UTF-8 UTF-8\\)/\\1/; s/^# *\\(en_US.UTF-8 UTF-8\\)/\\1/' /etc/locale.gen && locale-gen",
];

/** agent-browser's Chromium (pdf_create renders with it; agents' browsers use Google Chrome), in the home of the user commands run as. */
export const USER_STEPS = ["agent-browser install"];

/** The same image as a Dockerfile (for docker, other providers, or review). */
export function dockerfile() {
  return [
    `FROM ${BASE_IMAGE}`,
    `LABEL org.opencontainers.image.title="polpo-runner" org.opencontainers.image.version="${version}"`,
    ...ROOT_STEPS.map((s) => `RUN ${s}`),
    ...USER_STEPS.map((s) => `RUN ${s}`),
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { provider: "all", force: false, envFile: undefined, dockerfile: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force") out.force = true;
    else if (a === "--dockerfile") out.dockerfile = true;
    else if (a === "--provider") out.provider = argv[++i];
    else if (a === "--env-file") out.envFile = argv[++i];
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!["all", "daytona", "daytona-v2", "e2b"].includes(out.provider)) throw new Error(`--provider must be daytona, daytona-v2, e2b or all`);
  return out;
}

function loadEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const key = t.slice(0, t.indexOf("=")).trim();
    const value = t.slice(t.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
    if (value) env[key] = value;
  }
  return env;
}

const log = (msg) => console.log(`[build-sandbox-images] ${msg}`);
const elapsed = (t0) => `${Math.round((Date.now() - t0) / 1000)} s`;

async function buildDaytona(env, force) {
  const { Daytona, Image } = await import("@daytona/sdk");
  const daytona = new Daytona({ apiKey: env.DAYTONA_API_KEY, apiUrl: env.DAYTONA_API_URL || undefined, target: env.DAYTONA_TARGET || undefined });
  const existing = await daytona.snapshot.get(DAYTONA_SNAPSHOT).catch(() => undefined);
  if (existing && !force && !/error|failed/i.test(String(existing.state))) {
    log(`daytona: snapshot ${DAYTONA_SNAPSHOT} already exists (state ${existing.state})`);
    return DAYTONA_SNAPSHOT;
  }
  if (existing) {
    log(`daytona: deleting snapshot ${DAYTONA_SNAPSHOT} (state ${existing.state}) to rebuild it`);
    await daytona.snapshot.delete(existing);
    // deletion is asynchronous: the name is free once the snapshot is gone
    for (let i = 0; i < 60 && await daytona.snapshot.get(DAYTONA_SNAPSHOT).catch(() => undefined); i++) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  // Daytona runs commands as the image's user (root here): Chromium goes in root's home
  const image = Image.base(BASE_IMAGE).runCommands(...ROOT_STEPS, ...USER_STEPS);
  const t0 = Date.now();
  log(`daytona: building snapshot ${DAYTONA_SNAPSHOT} from ${BASE_IMAGE}…`);
  let lastLine = "";
  const snapshot = await daytona.snapshot.create(
    { name: DAYTONA_SNAPSHOT, image, resources: { cpu: 2, memory: 4, disk: 10 } },
    { timeout: 0, onLogs: (chunk) => { lastLine = String(chunk).trim().split("\n").pop() || lastLine; } },
  );
  log(`daytona: snapshot ${snapshot.name} ${snapshot.state} in ${elapsed(t0)}${lastLine && !/active/i.test(snapshot.state) ? ` (last log: ${lastLine.slice(0, 200)})` : ""}`);
  if (!/active/i.test(String(snapshot.state))) throw new Error(`Daytona snapshot ended in state ${snapshot.state}${snapshot.errorReason ? `: ${snapshot.errorReason}` : ""}`);
  return DAYTONA_SNAPSHOT;
}

/** How long a v2 image build may take (it installs Chromium and its libraries). */
const DAYTONA_V2_BUILD_SECONDS = 60 * 60;

/**
 * Daytona v2 (`@daytona/sdk` 2.x, aliased @daytona/sdk-v2): the same steps as an ImageBuilder,
 * built as the named image DAYTONA_V2_IMAGE in the project of DAYTONA_V2_API_KEY. v2 sandboxes are
 * Linux VMs; the image carries no size (each sandbox is sized when it is created).
 * `daytona` is injectable for tests (a v2 client: images.get/build/delete).
 */
export async function buildDaytonaV2(env, force, daytona) {
  if (!daytona) {
    const { Daytona } = await import("@daytona/sdk-v2");
    daytona = new Daytona({ apiKey: env.DAYTONA_V2_API_KEY }).v2;
  }
  const { ImageBuilder } = await import("@daytona/sdk-v2/v2");
  const region = env.DAYTONA_V2_REGION || undefined;
  let existing = await daytona.images.get(DAYTONA_V2_IMAGE).catch(() => undefined);
  if (existing && !force && /pending|building/i.test(String(existing.status))) {
    log(`daytona-v2: image ${DAYTONA_V2_IMAGE} is being built (${existing.status}): waiting for it`);
    existing = await daytona.images.get(existing.id, { wait: "ready", timeoutSeconds: DAYTONA_V2_BUILD_SECONDS });
  }
  if (existing && !force && existing.status === "ready") {
    log(`daytona-v2: image ${DAYTONA_V2_IMAGE} already exists (${existing.status}, class ${existing.sandboxClass})`);
    return DAYTONA_V2_IMAGE;
  }
  if (existing) {
    log(`daytona-v2: deleting image ${DAYTONA_V2_IMAGE} (${existing.status}) to rebuild it`);
    await daytona.images.delete(existing.id);
    for (let i = 0; i < 60 && await daytona.images.get(DAYTONA_V2_IMAGE).catch(() => undefined); i++) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  // commands run as the image's user (root here): Chromium goes in root's home
  const builder = ImageBuilder.fromRegistry(BASE_IMAGE).runCommands(...ROOT_STEPS, ...USER_STEPS);
  const t0 = Date.now();
  log(`daytona-v2: building image ${DAYTONA_V2_IMAGE} from ${BASE_IMAGE}${region ? ` in ${region}` : ""}…`);
  const submitted = await daytona.images.build(builder, { name: DAYTONA_V2_IMAGE, ...(region ? { region } : {}) });
  const image = await daytona.images.get(submitted.id, { wait: "ready", timeoutSeconds: DAYTONA_V2_BUILD_SECONDS });
  log(`daytona-v2: image ${image.name ?? DAYTONA_V2_IMAGE} (${image.id}) ${image.status} in ${elapsed(t0)}, class ${image.sandboxClass}`);
  if (image.status !== "ready") throw new Error(`Daytona v2 image ended ${image.status}${image.error ? `: ${image.error}` : ""}`);
  return DAYTONA_V2_IMAGE;
}

async function buildE2B(env, force) {
  const { Template, defaultBuildLogger } = await import("e2b");
  const conn = { apiKey: env.E2B_API_KEY, ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}) };
  if (!force && await Template.exists(E2B_TEMPLATE, conn).catch(() => false)) {
    log(`e2b: template ${E2B_TEMPLATE} already exists`);
    return E2B_TEMPLATE;
  }
  // E2B runs commands as "user": Chromium goes in that user's home
  const template = Template()
    .fromImage(BASE_IMAGE)
    .setUser("root")
    .runCmd(ROOT_STEPS)
    .setUser("user")
    .runCmd(USER_STEPS);
  const t0 = Date.now();
  log(`e2b: building template ${E2B_TEMPLATE} from ${BASE_IMAGE}…`);
  const info = await Template.build(template, E2B_TEMPLATE, {
    ...conn, cpuCount: 2, memoryMB: 4096, skipCache: force,
    onBuildLogs: process.env.POLPO_BUILD_LOGS ? defaultBuildLogger() : undefined,
  });
  log(`e2b: template ${info.name} (${info.templateId}) built in ${elapsed(t0)}`);
  return E2B_TEMPLATE;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dockerfile) {
    process.stdout.write(dockerfile());
    return;
  }
  const env = { ...(args.envFile ? loadEnvFile(args.envFile) : {}), ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
  const wanted = args.provider === "all" ? ["daytona", "daytona-v2", "e2b"] : [args.provider];
  const KEYS = { daytona: "DAYTONA_API_KEY", "daytona-v2": "DAYTONA_V2_API_KEY", e2b: "E2B_API_KEY" };
  const BUILD = { daytona: buildDaytona, "daytona-v2": buildDaytonaV2, e2b: buildE2B };
  const results = {};
  let failed = false;
  for (const provider of wanted) {
    if (!env[KEYS[provider]]) {
      log(`${provider}: no API key in the environment (${KEYS[provider]}), skipped`);
      continue;
    }
    try {
      results[provider] = await BUILD[provider](env, args.force);
    } catch (err) {
      failed = true;
      log(`${provider}: failed: ${err?.message ?? err}`);
    }
  }
  if (results.daytona) log(`set settings.sandbox.providers.daytona.snapshot = "${results.daytona}"`);
  if (results["daytona-v2"]) log(`Daytona v2: image "${results["daytona-v2"]}" is the default with providers.daytona.api = "v2" (set providers.daytona.image only to use another one)`);
  if (results.e2b) log(`set settings.sandbox.providers.e2b.template = "${results.e2b}"`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[build-sandbox-images] ${err?.message ?? err}`);
    process.exit(1);
  });
}
