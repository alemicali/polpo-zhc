#!/usr/bin/env node
/**
 * Build the Polpo runner image for the remote sandbox providers (like open Polpo's
 * docker/runner/Dockerfile): the tools agents use in a VM are preinstalled, so nothing is
 * downloaded at run time.
 *
 *   - agent-browser + its Chromium, with every shared library Chromium needs, and fonts;
 *     playwright-core (pdf_create renders HTML with that Chromium, in the VM)
 *   - mountpoint-s3, rclone and FUSE (storage mounts)
 *   - git, curl, python3 (+ edge-tts), poppler-utils, sudo, node 22
 *
 * Daytona: a snapshot built from the SDK's declarative Image, named "polpo-runner-<version>".
 * E2B: a template built with the SDK's Template builder, named "polpo-runner-<version with dashes>".
 *
 * Idempotent: an image that already exists (and is usable) is left alone; --force rebuilds it.
 * Then set, per instance, settings.sandbox.providers.daytona.snapshot / .e2b.template to the name.
 *
 * Keys come from the environment (DAYTONA_API_KEY, DAYTONA_API_URL, DAYTONA_TARGET, E2B_API_KEY,
 * E2B_DOMAIN) or from --env-file <path> (KEY=value lines). They are never printed.
 *
 *   node scripts/build-sandbox-images.mjs [--provider daytona|e2b|all] [--force] [--env-file f]
 *   node scripts/build-sandbox-images.mjs --dockerfile     # the equivalent Dockerfile, nothing built
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

export const BASE_IMAGE = "node:22-bookworm-slim";
export const DAYTONA_SNAPSHOT = `polpo-runner-${version}`;
export const E2B_TEMPLATE = `polpo-runner-${version.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

/** Debian packages: baseline tools, PDF text, python for edge-tts, FUSE, every library agent-browser's Chromium links against, fonts. */
const APT_PACKAGES = [
  "git", "curl", "ca-certificates", "sudo", "unzip", "procps", "fuse3", "libfuse2",
  "poppler-utils", "python3", "python3-pip",
  "libnss3", "libnspr4", "libatk1.0-0", "libatk-bridge2.0-0", "libcups2", "libxkbcommon0", "libxcomposite1",
  "libxdamage1", "libxrandr2", "libgbm1", "libxss1", "libasound2", "libpangocairo-1.0-0", "libpango-1.0-0",
  "libcairo2", "libwayland-client0", "libxshmfence1", "libxfixes3", "libxext6", "libxcursor1", "libxi6",
  "libxtst6", "libxrender1", "libxinerama1", "libdbus-1-3", "libatspi2.0-0", "libdrm2", "libx11-xcb1",
  "fonts-liberation", "fonts-dejavu-core", "fonts-noto-color-emoji",
];

/** Steps run as root, in order (shared by both providers and the printed Dockerfile). */
export const ROOT_STEPS = [
  `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")} && rm -rf /var/lib/apt/lists/*`,
  // mountpoint-s3 (S3/R2 FUSE mount), for this machine's architecture
  `ARCH=$(uname -m) && curl -fsSL "https://s3.amazonaws.com/mountpoint-s3-release/latest/$ARCH/mount-s3.deb" -o /tmp/mount-s3.deb && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/mount-s3.deb && rm -rf /tmp/mount-s3.deb /var/lib/apt/lists/*`,
  // rclone (what Polpo mounts granted buckets with)
  "curl -fsSL https://rclone.org/install.sh | bash",
  // edge-tts: free voices for audio_speak (slim Debian is PEP 668 locked)
  "pip install --no-cache-dir --break-system-packages edge-tts",
  // agent-browser CLI (its Chromium is downloaded per user, below); playwright-core for pdf_create
  "npm install -g agent-browser playwright-core && npm cache clean --force",
  "sed -i 's/^# *user_allow_other/user_allow_other/' /etc/fuse.conf || true",
];

/** Chromium for agent-browser, in the home of the user commands run as. */
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
  if (!["all", "daytona", "e2b"].includes(out.provider)) throw new Error(`--provider must be daytona, e2b or all`);
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
  const { Daytona, Image } = await import("@daytonaio/sdk");
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
  const wanted = args.provider === "all" ? ["daytona", "e2b"] : [args.provider];
  const results = {};
  let failed = false;
  for (const provider of wanted) {
    const key = provider === "daytona" ? env.DAYTONA_API_KEY : env.E2B_API_KEY;
    if (!key) {
      log(`${provider}: no API key in the environment, skipped`);
      continue;
    }
    try {
      results[provider] = provider === "daytona" ? await buildDaytona(env, args.force) : await buildE2B(env, args.force);
    } catch (err) {
      failed = true;
      log(`${provider}: failed: ${err?.message ?? err}`);
    }
  }
  if (results.daytona) log(`set settings.sandbox.providers.daytona.snapshot = "${results.daytona}"`);
  if (results.e2b) log(`set settings.sandbox.providers.e2b.template = "${results.e2b}"`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`[build-sandbox-images] ${err?.message ?? err}`);
    process.exit(1);
  });
}
