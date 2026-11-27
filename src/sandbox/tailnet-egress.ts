/**
 * Tailscale inside a remote computer (Daytona v0/v2, E2B), so the browser there goes out through
 * a proxy that only the tailnet reaches (settings.egressProxies, e.g. "home" =
 * socks5://100.101.55.7:1080 on a machine at home). Settings and rules: packages/core/src/tailnet.ts.
 *
 * In the VM, everything lives in TAILNET_DIR (0700, /tmp: nothing survives a delete):
 *   - tailscale + tailscaled: in the runner images (scripts/build-sandbox-images.mjs); otherwise a
 *     pinned release is downloaded and its SHA-256 checked;
 *   - tailscaled in userspace networking (no TUN, no root), its SOCKS5 server on 127.0.0.1:1055,
 *     state in memory (with an ephemeral key the node leaves the tailnet when the VM goes away);
 *   - `tailscale up` with the auth key from a 0600 file uploaded through the provider's file API
 *     (never on a command line, never in a log), deleted right after; hostname
 *     `<prefix>-<instance>-<computer>`, the settings' tags, --accept-dns=false;
 *   - a small forwarder on 127.0.0.1:1081: each connection opens a SOCKS5 CONNECT to the proxy
 *     through tailscaled's SOCKS5 server and then pipes bytes, so 1081 behaves as the proxy itself
 *     and the browser runs with `--proxy socks5://127.0.0.1:1081`.
 *
 * ensure() is idempotent: it looks at what runs (one command when all is up), starts only what is
 * missing (after a resume or a container restart the daemons may be gone), and checks the proxy
 * answers end to end through the tailnet. A stale node is restarted and joins again: a tailscaled
 * still alive after a start or resume (it came back from a memory snapshot, with an ephemeral node
 * the tailnet has likely removed), or one that says "Running" while the proxy does not answer and
 * it is offline / has no network map / cannot reach the coordination server. The result is cached
 * briefly per computer. When the proxy is not reachable the browser behaves as on the server
 * (browser-egress.ts): directly from the VM, except a profile signed in through the proxy, which
 * pauses.
 */
import type { VaultStore } from "@polpo-ai/core";
import { TAILSCALE_AUTH_KEY_NAMES, type TailnetEgressRef } from "@polpo-ai/core/sandbox";
import { pickCredential, resolveVaultRef } from "@polpo-ai/core/vault-ref";
import { createSecretMasker } from "../vault/env-from-vault.js";

/** Pinned Tailscale release for VMs without it (the runner images install the same one). */
export const TAILSCALE_VERSION = "1.104.7";
/** SHA-256 of tailscale_<version>_<arch>.tgz from pkgs.tailscale.com/stable. */
export const TAILSCALE_SHA256: Readonly<Record<"amd64" | "arm64", string>> = {
  amd64: "e56693ff74a64f2591b7e819c280635a100aae1ddfb0ef058fcd052b7cd8d16c",
  arm64: "d6bed2720310b328b861f943d7b4016c5358a9bad60575eb51e8143b79068484",
};
export const TAILNET_DIR = "/tmp/polpo-tailnet";
export const TAILNET_SOCKET = `${TAILNET_DIR}/tailscaled.sock`;
export const TAILNET_AUTH_KEY_FILE = `${TAILNET_DIR}/authkey`;
export const TAILNET_FORWARDER_FILE = `${TAILNET_DIR}/forwarder.mjs`;
/** tailscaled's own SOCKS5 server (any tailnet destination). */
export const TAILNET_SOCKS_PORT = 1055;
/** The forwarder: behaves as the egress proxy. */
export const TAILNET_FORWARD_PORT = 1081;
/** What the browser in the VM is started with when it goes out through the tailnet. */
export const TAILNET_BROWSER_PROXY = `socks5://127.0.0.1:${TAILNET_FORWARD_PORT}`;
/** How long a check of a computer's tailnet is trusted. */
export const TAILNET_STATUS_TTL_MS = 30_000;
/** Without a network map from the coordination server for longer than this, a node is stale. */
export const TAILNET_NETMAP_STALE_MS = 10 * 60_000;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Where the binaries are: the image's (PATH), else the downloaded ones. */
const FIND_BINARIES =
  `D=${TAILNET_DIR}; SOCK=${TAILNET_SOCKET}; `
  + `TS=$(command -v tailscale 2>/dev/null || { [ -x "$D/bin/tailscale" ] && echo "$D/bin/tailscale"; }); `
  + `TSD=$(command -v tailscaled 2>/dev/null || { [ -x "$D/bin/tailscaled" ] && echo "$D/bin/tailscaled"; }); `
  + `alive() { [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; }; `;

/**
 * What runs now, and (when everything does) whether the proxy answers. Two end-to-end probes, each
 * a SOCKS5 greeting answered by the proxy itself at home:
 *   - probe: through the forwarder on 127.0.0.1:1081 (it relays the greeting only once tailscaled
 *     connected it to the proxy, so a forwarder that merely listens does not pass);
 *   - tunnel: straight through tailscaled's SOCKS5 server on 127.0.0.1:1055 to the proxy
 *     (fwd.target), without the forwarder: tells a broken forwarder from a broken tailnet.
 * fwdv2: whether the VM's forwarder.mjs knows the tunnel probe (an older one is rewritten).
 */
export const TAILNET_INSPECT_COMMAND = FIND_BINARIES
  + `if [ -n "$TS" ] && [ -n "$TSD" ]; then echo bin=1; else echo bin=0; fi; `
  + `if alive "$D/tailscaled.pid" && [ -S "$SOCK" ]; then echo daemon=1; else echo daemon=0; fi; `
  + `if alive "$D/fwd.pid"; then echo forwarder=1; else echo forwarder=0; fi; `
  + `T=$(cat "$D/fwd.target" 2>/dev/null); echo "target=$T"; `
  + `if [ -f "$D/forwarder.mjs" ]; then if grep -q probe-via "$D/forwarder.mjs" 2>/dev/null; then echo fwdv2=1; else echo fwdv2=0; fi; fi; `
  + `if alive "$D/fwd.pid" && command -v node >/dev/null 2>&1; then if node "$D/forwarder.mjs" probe 127.0.0.1 ${TAILNET_FORWARD_PORT} >/dev/null 2>&1; then echo probe=1; else echo probe=0; fi; fi; `
  + `if [ -n "$T" ] && alive "$D/tailscaled.pid" && [ -S "$SOCK" ] && command -v node >/dev/null 2>&1 && grep -q probe-via "$D/forwarder.mjs" 2>/dev/null; then `
  + `if node "$D/forwarder.mjs" probe-via ${TAILNET_SOCKS_PORT} "\${T%:*}" "\${T##*:}" >/dev/null 2>&1; then echo tunnel=1; else echo tunnel=0; fi; fi; `
  + `echo ---status---; `
  + `if [ -n "$TS" ] && [ -S "$SOCK" ]; then "$TS" --socket="$SOCK" status --json 2>/dev/null; fi; true`;

/** Download the pinned release into TAILNET_DIR/bin, checking its SHA-256. */
export const TAILNET_INSTALL_COMMAND =
  `set -e; D=${TAILNET_DIR}; mkdir -p "$D/bin"; chmod 700 "$D"; `
  + `case "$(uname -m)" in x86_64|amd64) A=amd64; SUM=${TAILSCALE_SHA256.amd64};; aarch64|arm64) A=arm64; SUM=${TAILSCALE_SHA256.arm64};; `
  + `*) echo "Tailscale: unsupported architecture $(uname -m)" >&2; exit 2;; esac; `
  + `F=tailscale_${TAILSCALE_VERSION}_$A; `
  + `curl -fsSL --retry 2 -o "$D/ts.tgz" "https://pkgs.tailscale.com/stable/$F.tgz"; `
  + `if ! echo "$SUM  $D/ts.tgz" | sha256sum -c - >/dev/null 2>&1; then rm -f "$D/ts.tgz"; echo "Tailscale download: checksum mismatch" >&2; exit 3; fi; `
  + `tar xzf "$D/ts.tgz" -C "$D"; mv "$D/$F/tailscale" "$D/$F/tailscaled" "$D/bin/"; rm -rf "$D/$F" "$D/ts.tgz"; "$D/bin/tailscale" version | head -1`;

/** tailscaled in userspace networking, SOCKS5 on 127.0.0.1:1055, state in memory (once). */
export const TAILNET_DAEMON_COMMAND = FIND_BINARIES
  + `mkdir -p "$D"; chmod 700 "$D"; `
  + `[ -n "$TSD" ] || { echo "tailscaled is not installed" >&2; exit 2; }; `
  + `if ! alive "$D/tailscaled.pid"; then rm -f "$SOCK"; S=$(command -v setsid 2>/dev/null || true); `
  + `$S nohup "$TSD" --tun=userspace-networking --socks5-server=127.0.0.1:${TAILNET_SOCKS_PORT} --state=mem: --socket="$SOCK" >"$D/tailscaled.log" 2>&1 </dev/null & echo $! >"$D/tailscaled.pid"; fi; `
  + `i=0; while [ $i -lt 50 ]; do [ -S "$SOCK" ] && exit 0; sleep 0.2; i=$((i+1)); done; `
  + `echo "tailscaled did not start: $(tail -c 400 "$D/tailscaled.log" 2>/dev/null)" >&2; exit 1`;

/** `tailscale up` with the key file (removed whatever happens). */
export function tailnetUpCommand(hostname: string, tags: string[]): string {
  return FIND_BINARIES
    + `chmod 600 "$D/authkey" 2>/dev/null; `
    + `"$TS" --socket="$SOCK" up --reset --auth-key=file:"$D/authkey" --hostname=${q(hostname)}`
    + `${tags.length ? ` --advertise-tags=${q(tags.join(","))}` : ""} --accept-dns=false --timeout=60s >"$D/up.log" 2>&1; rc=$?; `
    + `rm -f "$D/authkey"; [ $rc -eq 0 ] || tail -c 600 "$D/up.log" >&2; exit $rc`;
}

/** The forwarder on 127.0.0.1:1081 to the proxy (restarted when the proxy changed). */
export function tailnetForwarderCommand(host: string, port: number): string {
  const target = `${host}:${port}`;
  return FIND_BINARIES
    + `T=${q(target)}; `
    + `if alive "$D/fwd.pid" && [ "$(cat "$D/fwd.target" 2>/dev/null)" = "$T" ]; then exit 0; fi; `
    + `command -v node >/dev/null 2>&1 || { echo "node is not installed: the tailnet forwarder needs it" >&2; exit 2; }; `
    + `if alive "$D/fwd.pid"; then kill "$(cat "$D/fwd.pid")" 2>/dev/null; sleep 0.3; fi; S=$(command -v setsid 2>/dev/null || true); `
    + `$S nohup node "$D/forwarder.mjs" serve ${TAILNET_FORWARD_PORT} ${TAILNET_SOCKS_PORT} ${q(host)} ${port} >"$D/forwarder.log" 2>&1 </dev/null & echo $! >"$D/fwd.pid"; `
    + `printf '%s' "$T" >"$D/fwd.target"; sleep 0.3; `
    + `alive "$D/fwd.pid" || { echo "the tailnet forwarder did not start: $(tail -c 400 "$D/forwarder.log" 2>/dev/null)" >&2; exit 1; }`;
}

/**
 * A clean restart of the tailnet in the VM (a stale node: restored from a memory snapshot, removed
 * from the tailnet, no network map for a long time): leave the tailnet if the coordination server
 * still answers (best effort, bounded), stop the forwarder and tailscaled (SIGKILL when they do
 * not go), remove the socket, pid files and the forwarder's target. TAILNET_DAEMON_COMMAND then
 * starts tailscaled again with fresh in-memory state, `tailscale up` joins with the auth key, and
 * the forwarder starts again.
 */
export const TAILNET_RESTART_COMMAND = FIND_BINARIES
  + `if [ -n "$TS" ] && [ -S "$SOCK" ]; then timeout 5 "$TS" --socket="$SOCK" logout >/dev/null 2>&1 || true; fi; `
  + `for p in fwd tailscaled; do if alive "$D/$p.pid"; then P=$(cat "$D/$p.pid"); kill "$P" 2>/dev/null; i=0; `
  + `while kill -0 "$P" 2>/dev/null && [ $i -lt 25 ]; do sleep 0.2; i=$((i+1)); done; kill -9 "$P" 2>/dev/null; fi; rm -f "$D/$p.pid"; done; `
  + `rm -f "$SOCK" "$D/fwd.target" "$D/authkey"; true`;

/** Stop the forwarder only (its tunnel works but it does not relay): it is started again. */
export const TAILNET_FORWARDER_STOP_COMMAND = FIND_BINARIES
  + `if alive "$D/fwd.pid"; then kill "$(cat "$D/fwd.pid")" 2>/dev/null; sleep 0.3; fi; rm -f "$D/fwd.pid" "$D/fwd.target"; true`;

/** Leave the tailnet (computer reset or deleted): best effort. */
export const TAILNET_LOGOUT_COMMAND = FIND_BINARIES
  + `if [ -n "$TS" ] && [ -S "$SOCK" ]; then timeout 15 "$TS" --socket="$SOCK" logout >/dev/null 2>&1 || true; fi; `
  + `for p in fwd tailscaled; do alive "$D/$p.pid" && kill "$(cat "$D/$p.pid")" 2>/dev/null; done; rm -f "$D/authkey"; true`;

/**
 * The forwarder, run with node in the VM (no dependencies).
 *   serve <listenPort> <socksPort> <host> <port>: 127.0.0.1:<listenPort> → SOCKS5 CONNECT host:port
 *     through 127.0.0.1:<socksPort>, then raw bytes both ways;
 *   probe <host> <port>: a SOCKS5 greeting answered by a SOCKS5 server (exit 0);
 *   probe-via <socksPort> <host> <port>: through the SOCKS5 server on 127.0.0.1:<socksPort>
 *     (tailscaled's), CONNECT host:port, then a SOCKS5 greeting answered there (exit 0).
 */
export const TAILNET_FORWARDER_SCRIPT = `// Polpo tailnet forwarder (src/sandbox/tailnet-egress.ts)
import net from "node:net";
const [mode, ...a] = process.argv.slice(2);
function connectRequest(host, port) {
  const v4 = net.isIPv4(host);
  const addr = v4 ? Buffer.from(host.split(".").map(Number)) : Buffer.concat([Buffer.from([Buffer.byteLength(host)]), Buffer.from(host)]);
  return Buffer.concat([Buffer.from([5, 1, 0, v4 ? 1 : 3]), addr, Buffer.from([(port >> 8) & 255, port & 255])]);
}
if (mode === "probe") {
  const s = net.connect({ host: a[0], port: Number(a[1]) });
  const timer = setTimeout(() => { s.destroy(); process.exit(2); }, 8000);
  s.on("connect", () => s.write(Buffer.from([5, 2, 0, 2])));
  s.once("data", (d) => { clearTimeout(timer); s.destroy(); process.exit(d[0] === 5 && (d[1] === 0 || d[1] === 2) ? 0 : 3); });
  s.on("error", () => process.exit(1));
  s.on("close", () => process.exit(4));
} else if (mode === "probe-via") {
  const [socksPort, host, port] = [Number(a[0]), a[1], Number(a[2])];
  const s = net.connect({ host: "127.0.0.1", port: socksPort });
  const timer = setTimeout(() => { s.destroy(); process.exit(2); }, 6000);
  let stage = 0;
  let buf = Buffer.alloc(0);
  const done = (code) => { clearTimeout(timer); s.destroy(); process.exit(code); };
  s.on("connect", () => s.write(Buffer.from([5, 1, 0])));
  s.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (stage === 0) {
      if (buf.length < 2) return;
      if (buf[0] !== 5 || buf[1] !== 0) return done(3);
      buf = buf.subarray(2);
      stage = 1;
      s.write(connectRequest(host, port));
    }
    if (stage === 1) {
      if (buf.length < 5) return;
      if (buf[1] !== 0) return done(5);
      const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
      if (buf.length < len) return;
      buf = buf.subarray(len);
      stage = 2;
      s.write(Buffer.from([5, 2, 0, 2]));
    }
    if (stage === 2) {
      if (buf.length < 2) return;
      done(buf[0] === 5 && (buf[1] === 0 || buf[1] === 2) ? 0 : 6);
    }
  });
  s.on("error", () => process.exit(1));
  s.on("close", () => process.exit(4));
} else if (mode === "serve") {
  const [listenPort, socksPort, host, port] = [Number(a[0]), Number(a[1]), a[2], Number(a[3])];
  const server = net.createServer((client) => {
    client.pause();
    const up = net.connect({ host: "127.0.0.1", port: socksPort });
    let stage = 0;
    let buf = Buffer.alloc(0);
    const fail = () => { client.destroy(); up.destroy(); };
    up.setTimeout(30000, fail);
    up.on("connect", () => up.write(Buffer.from([5, 1, 0])));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return fail();
        buf = buf.subarray(2);
        stage = 1;
        up.write(connectRequest(host, port));
      }
      if (stage === 1) {
        if (buf.length < 5) return;
        if (buf[1] !== 0) return fail();
        const len = buf[3] === 1 ? 10 : buf[3] === 4 ? 22 : 7 + buf[4];
        if (buf.length < len) return;
        const rest = buf.subarray(len);
        stage = 2;
        up.off("data", onData);
        up.setTimeout(0);
        if (rest.length) client.write(rest);
        client.pipe(up);
        up.pipe(client);
        client.resume();
      }
    };
    up.on("data", onData);
    up.on("error", fail);
    client.on("error", fail);
    up.on("close", () => client.destroy());
    client.on("close", () => up.destroy());
  });
  server.on("error", (err) => { console.error(String(err && err.message || err)); process.exit(1); });
  server.listen(listenPort, "127.0.0.1");
} else {
  console.error("usage: forwarder.mjs serve <listenPort> <socksPort> <host> <port> | probe <host> <port> | probe-via <socksPort> <host> <port>");
  process.exit(64);
}
`;

// ── Where the commands run ─────────────────────────────────────────────

/** A machine to run commands on and upload files to (a computer's driver, or a run's shell + fs). */
export interface TailnetHost {
  exec(command: string, opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Through the provider's file API (keys never go through a command line). */
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface TailnetStatus {
  computerId: string;
  /** up: logged in and running; down: not running (or not logged in); starting: logging in. */
  tailnet: "up" | "down" | "starting";
  /** The node's name in the tailnet. */
  node?: string;
  tailnetIp?: string;
  /** How this node reaches the proxy's machine: directly (peer to peer) or through a DERP relay. */
  path?: "direct" | "derp" | "unknown";
  /** The DERP region relaying, when known ("fra", "nyc"…). */
  relay?: string;
  /** The proxy answered through the tailnet. */
  proxyReachable: boolean;
  checkedAt: string;
  /** Why the tailnet or the proxy is not usable. */
  error?: string;
  /** The node was stale (restored from a snapshot, removed from the tailnet): it is re-joining now. */
  rejoining?: boolean;
}

interface Inspection {
  bin: boolean;
  daemon: boolean;
  forwarder: boolean;
  target: string;
  /** The proxy answered a greeting through the forwarder (only when the forwarder runs). */
  probe?: boolean;
  /** The proxy answered a greeting straight through tailscaled's SOCKS5 server (when known). */
  tunnel?: boolean;
  /** The VM's forwarder.mjs knows the tunnel probe (undefined: no file). */
  fwdv2?: boolean;
  status?: TailscaleStatusJson;
}

interface TailscalePeerJson {
  HostName?: string;
  DNSName?: string;
  TailscaleIPs?: string[];
  CurAddr?: string;
  Relay?: string;
  Online?: boolean;
}

interface TailscaleStatusJson {
  BackendState?: string;
  Self?: TailscalePeerJson;
  Peer?: Record<string, TailscalePeerJson>;
  /** tailscaled's health warnings ("Unable to connect to the Tailscale coordination server…"). */
  Health?: string[] | null;
}

export function parseInspection(stdout: string): Inspection {
  const at = stdout.indexOf("---status---");
  const head = at < 0 ? stdout : stdout.slice(0, at);
  const kv = Object.fromEntries(head.split("\n").map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  let status: TailscaleStatusJson | undefined;
  if (at >= 0) {
    const json = stdout.slice(at + "---status---".length).trim();
    if (json) { try { status = JSON.parse(json) as TailscaleStatusJson; } catch { /* not ready */ } }
  }
  return {
    bin: kv.bin === "1",
    daemon: kv.daemon === "1",
    forwarder: kv.forwarder === "1",
    target: kv.target ?? "",
    ...(kv.probe !== undefined ? { probe: kv.probe === "1" } : {}),
    ...(kv.tunnel !== undefined ? { tunnel: kv.tunnel === "1" } : {}),
    ...(kv.fwdv2 !== undefined ? { fwdv2: kv.fwdv2 === "1" } : {}),
    ...(status ? { status } : {}),
  };
}

/** The node, and how it reaches the proxy's machine, from `tailscale status --json`. */
export function describeTailnet(status: TailscaleStatusJson | undefined, proxyHost: string): Pick<TailnetStatus, "tailnet" | "node" | "tailnetIp" | "path" | "relay"> {
  const state = status?.BackendState ?? "";
  const tailnet: TailnetStatus["tailnet"] = state === "Running" ? "up" : state === "Starting" ? "starting" : "down";
  const self = status?.Self;
  // before login Self.HostName is the VM's own name, not a tailnet node
  const node = (self?.DNSName || (tailnet === "up" ? self?.HostName : "") || "").replace(/\.$/, "") || undefined;
  const host = proxyHost.toLowerCase();
  const peer = Object.values(status?.Peer ?? {}).find((p) => p.TailscaleIPs?.includes(proxyHost)
    || p.HostName?.toLowerCase() === host
    || (p.DNSName ?? "").toLowerCase().replace(/\.$/, "") === host
    || (p.DNSName ?? "").toLowerCase().startsWith(`${host}.`));
  let path: TailnetStatus["path"];
  let relay: string | undefined;
  if (peer) {
    if (peer.CurAddr) path = "direct";
    else if (peer.Relay) { path = "derp"; relay = peer.Relay; }
    else path = "unknown";
  }
  return { tailnet, ...(node ? { node } : {}), ...(self?.TailscaleIPs?.[0] ? { tailnetIp: self.TailscaleIPs[0] } : {}), ...(path ? { path } : {}), ...(relay ? { relay } : {}) };
}

/** A Go duration ("63h", "1h2m3.5s", "45s", "250ms") in milliseconds; undefined when it is not one. */
export function goDurationMs(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|h|m|s)/g)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== text) return undefined;
  const unit: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return parts.reduce((ms, p) => ms + Number(p[1]) * unit[p[2]!]!, 0);
}

/**
 * Why a node that says it runs is stale, from `tailscale status --json`, when it is: offline in
 * the tailnet (an ephemeral node removed while its VM slept), no network map for longer than
 * TAILNET_NETMAP_STALE_MS, or no contact with the coordination server. Only BackendState
 * "Running" is looked at (any other state goes through `tailscale up` anyway).
 */
export function tailnetStaleReason(status: TailscaleStatusJson | undefined): string | undefined {
  if (status?.BackendState !== "Running") return undefined;
  const reasons: string[] = [];
  if (status.Self?.Online === false) reasons.push("the node is offline in the tailnet (an ephemeral node is removed while its VM sleeps)");
  const health = (status.Health ?? []).filter((h) => typeof h === "string");
  const netmap = health.map((h) => /network map from the coordination server in ([0-9.a-zµ]+)/i.exec(h)?.[1]).find(Boolean);
  const age = netmap ? goDurationMs(netmap.replace(/\.$/, "")) : undefined;
  if (age !== undefined && age > TAILNET_NETMAP_STALE_MS) reasons.push(`no network map from the coordination server for ${netmap!.replace(/\.$/, "")}`);
  else if (health.some((h) => /coordination server/i.test(h) && !/network map/i.test(h))) reasons.push("it cannot reach the Tailscale coordination server");
  return reasons.length ? reasons.join("; ") : undefined;
}

/** The proxy answered end to end (through the forwarder, and through the tunnel when that was probed). */
const answers = (ins: Inspection) => ins.probe === true && ins.tunnel !== false;

// ── Settings in this process ───────────────────────────────────────────

let vaultStore: VaultStore | undefined;
let egressFor: ((computer: { id: string; kind: string; egress?: string }) => { name: string; url: string; tailnet?: TailnetEgressRef } | undefined) | undefined;

/**
 * Where to read auth keys (the vault) and, for computers starting or resuming, their tailnet
 * egress (the server: from the settings; a task runner: from its run). Called once per process.
 */
export function configureTailnetEgress(opts: {
  vaultStore?: VaultStore;
  egressFor?: (computer: { id: string; kind: string; egress?: string }) => { name: string; url: string; tailnet?: TailnetEgressRef } | undefined;
}): void {
  if (opts.vaultStore) vaultStore = opts.vaultStore;
  if (opts.egressFor) egressFor = opts.egressFor;
}

/** The auth key from its vault entry (only in memory, on its way to the VM's 0600 file). */
async function readAuthKey(ref: TailnetEgressRef, store: VaultStore | undefined): Promise<string | undefined> {
  return pickCredential(await resolveVaultRef(store, ref.authKey), TAILSCALE_AUTH_KEY_NAMES);
}

// ── The runtime ─────────────────────────────────────────────────────────

export interface TailnetEgressOptions {
  /** Tests: the vault, the clock. */
  vaultStore?: VaultStore;
  now?: () => number;
  /** Progress for the agent or the logs ("joining the tailnet…"); never holds a secret. */
  onProgress?: (message: string) => void;
}

const enc = (s: string) => new TextEncoder().encode(s);

export class TailnetEgress {
  private readonly cache = new Map<string, { status: TailnetStatus; at: number; target: string }>();
  private readonly inflight = new Map<string, Promise<TailnetStatus>>();
  /** Computers started or resumed since their last check: a tailscaled still alive there came back from a memory snapshot. */
  private readonly restored = new Set<string>();
  /** Computers re-joining the tailnet now, and why. */
  private readonly rejoining = new Map<string, string>();

  constructor(private readonly opts: TailnetEgressOptions = {}) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  /** The last check of a computer (no command run); while it re-joins, says so. */
  last(computerId: string): TailnetStatus | undefined {
    const status = this.cache.get(computerId)?.status;
    const why = this.rejoining.get(computerId);
    if (!why) return status;
    return { ...(status ?? { computerId, proxyReachable: false, checkedAt: new Date(this.now()).toISOString() }), tailnet: "starting", proxyReachable: false, rejoining: true, error: `Re-joining the tailnet (${why})` };
  }

  /**
   * Forget a computer's check (it started, resumed or was reset: the daemons may be gone).
   * `restored`: it was started or resumed, maybe from a memory snapshot: a tailscaled found alive on
   * the next ensure() came back from that snapshot and is restarted (see ensureNow).
   */
  invalidate(computerId?: string, o: { restored?: boolean } = {}): void {
    if (computerId) {
      this.cache.delete(computerId);
      if (o.restored) this.restored.add(computerId);
    } else this.cache.clear();
  }

  /**
   * The computer is in the tailnet and the proxy answers through it: start whatever is missing,
   * re-join when the node is stale. Never throws: a failure is a status with `error` (and
   * proxyReachable false).
   */
  ensure(host: TailnetHost, ref: TailnetEgressRef, o: { force?: boolean } = {}): Promise<TailnetStatus> {
    const target = `${ref.proxyHost}:${ref.proxyPort}`;
    // a check (or a re-join) on its way is newer than any cached one
    const running = this.inflight.get(ref.computerId);
    if (running) return running;
    const hit = this.cache.get(ref.computerId);
    // a restored computer is always looked at again (never the cached steady state)
    if (!o.force && !this.restored.has(ref.computerId) && hit && hit.target === target && this.now() - hit.at < TAILNET_STATUS_TTL_MS) return Promise.resolve(hit.status);
    const run = this.ensureNow(host, ref).then((status) => {
      this.cache.set(ref.computerId, { status, at: this.now(), target });
      return status;
    }).finally(() => {
      this.inflight.delete(ref.computerId);
      this.rejoining.delete(ref.computerId);
    });
    this.inflight.set(ref.computerId, run);
    return run;
  }

  /**
   * What runs now, without starting anything (status for people and Polpo). A stale node is
   * re-joined in the background (the status says "re-joining the tailnet").
   */
  async inspect(host: TailnetHost, ref: TailnetEgressRef): Promise<TailnetStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    if (this.rejoining.has(ref.computerId)) return this.last(ref.computerId)!;
    try {
      const r = await host.exec(TAILNET_INSPECT_COMMAND, { timeoutMs: 30_000 });
      const ins = parseInspection(r.stdout);
      const desc = describeTailnet(ins.status, ref.proxyHost);
      const targetOk = ins.target === `${ref.proxyHost}:${ref.proxyPort}`;
      const status: TailnetStatus = {
        computerId: ref.computerId, ...desc,
        ...(ins.daemon ? {} : { tailnet: "down" as const }),
        proxyReachable: desc.tailnet === "up" && ins.forwarder && targetOk && answers(ins),
        checkedAt,
      };
      if (!ins.bin) status.error = "Tailscale is not installed in the VM yet (it is installed on the browser's first use)";
      else if (!ins.daemon) status.error = "tailscaled is not running (it starts on the browser's next use)";
      const stale = ins.daemon && !status.proxyReachable ? tailnetStaleReason(ins.status) : undefined;
      if (stale) {
        // never left as is: re-joined now, in the background (the browser waits for it on its next use)
        const running = this.inflight.has(ref.computerId);
        void this.ensure(host, ref, { force: true }).catch(() => undefined);
        if (!running) this.rejoining.set(ref.computerId, stale);
        return { ...status, tailnet: "starting", proxyReachable: false, rejoining: true, error: `The tailnet node is stale (${stale}): re-joining the tailnet` };
      }
      this.cache.set(ref.computerId, { status, at: this.now(), target: `${ref.proxyHost}:${ref.proxyPort}` });
      return status;
    } catch (err) {
      return { computerId: ref.computerId, tailnet: "down", proxyReachable: false, checkedAt, error: (err as Error).message ?? String(err) };
    }
  }

  /** Leave the tailnet and stop the daemons (best effort). */
  async logout(host: TailnetHost, computerId?: string): Promise<void> {
    if (computerId) { this.invalidate(computerId); this.restored.delete(computerId); }
    await host.exec(TAILNET_LOGOUT_COMMAND, { timeoutMs: 30_000 }).catch(() => undefined);
  }

  /**
   * Look, then bring up what is missing. A stale node (restored from a memory snapshot, or
   * tailnetStaleReason while the proxy does not answer) is restarted cleanly and joins again; a
   * `tailscale up` that fails on a daemon that was already there gets the same treatment. At most
   * one restart per call: when it still fails, the error says why (the next call tries again).
   */
  private async ensureNow(host: TailnetHost, ref: TailnetEgressRef): Promise<TailnetStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    let rejoinReason: string | undefined;
    const down = (error: string, extra: Partial<TailnetStatus> = {}): TailnetStatus => ({
      computerId: ref.computerId, tailnet: "down", proxyReachable: false, checkedAt,
      error: rejoinReason ? `Re-joining the tailnet (${rejoinReason}) failed: ${error}. It is tried again on the browser's next use` : error,
      ...extra,
    });
    let key: string | undefined;
    // whatever a command prints, the key never leaves this function
    const mask = (text: string) => (key ? createSecretMasker([key])(text) : text);
    const run = async (command: string, timeoutMs: number) => {
      const r = await host.exec(command, { timeoutMs });
      return { ...r, stdout: mask(r.stdout ?? ""), stderr: mask(r.stderr ?? "") };
    };
    const why = (r: { stdout: string; stderr: string; exitCode: number }) => (r.stderr || r.stdout).trim().slice(-400) || `exit ${r.exitCode}`;
    const look = async () => parseInspection((await run(TAILNET_INSPECT_COMMAND, 30_000)).stdout);
    const restored = this.restored.delete(ref.computerId);
    try {
      let ins = await look();
      const target = `${ref.proxyHost}:${ref.proxyPort}`;
      // a tailscaled alive right after a start or resume came back from a memory snapshot: its
      // in-memory state and ephemeral node are from before the sleep (the node is likely gone from
      // the tailnet, and right after the resume it may still look fine): always restarted
      let stale = ins.daemon && restored ? "the computer was restored from a memory snapshot" : undefined;
      if (!stale && ins.daemon && !answers(ins)) stale = tailnetStaleReason(ins.status);
      // steady state: everything runs and the proxy answers end to end
      if (!stale && ins.daemon && ins.forwarder && ins.target === target && answers(ins) && ins.status?.BackendState === "Running") {
        // an older forwarder.mjs (without the tunnel probe) is replaced for the next look
        if (ins.fwdv2 === false) await host.writeFile(TAILNET_FORWARDER_FILE, enc(TAILNET_FORWARDER_SCRIPT)).catch(() => undefined);
        return { computerId: ref.computerId, ...describeTailnet(ins.status, ref.proxyHost), proxyReachable: true, checkedAt };
      }
      if (!ins.bin) {
        this.opts.onProgress?.(`Installing Tailscale ${TAILSCALE_VERSION} in computer "${ref.computerId}"…`);
        const r = await run(TAILNET_INSTALL_COMMAND, 240_000);
        if (r.exitCode !== 0) return down(`Tailscale could not be installed in the VM: ${why(r)}`);
      }
      let restarts = 0;
      const restart = async (reason: string) => {
        restarts++;
        rejoinReason = reason;
        this.rejoining.set(ref.computerId, reason);
        this.opts.onProgress?.(`Computer "${ref.computerId}" is re-joining the tailnet (${reason})…`);
        const r = await run(TAILNET_RESTART_COMMAND, 60_000);
        if (r.exitCode !== 0) this.opts.onProgress?.(`Stopping the old tailnet daemons of "${ref.computerId}" did not finish cleanly: ${why(r)}`);
        ins = await look();
      };
      if (stale) await restart(stale);
      for (;;) {
        let started = false;
        if (!ins.daemon) {
          const r = await run(TAILNET_DAEMON_COMMAND, 30_000);
          if (r.exitCode !== 0) return down(`tailscaled could not start: ${why(r)}`);
          started = true;
          ins = await look();
        }
        if (ins.status?.BackendState !== "Running") {
          key = await readAuthKey(ref, this.opts.vaultStore ?? vaultStore);
          if (!key) return down(`No Tailscale auth key in the vault entry ${ref.authKey.owner} / ${ref.authKey.service} (settings.tailscale.authKey)`);
          if (!rejoinReason) this.opts.onProgress?.(`Computer "${ref.computerId}" is joining the tailnet as ${ref.hostname}…`);
          let failed: string | undefined;
          try {
            await host.writeFile(TAILNET_AUTH_KEY_FILE, enc(key));
            const r = await run(tailnetUpCommand(ref.hostname, ref.tags), 90_000);
            if (r.exitCode !== 0) failed = `tailscale up failed: ${why(r)}`;
          } finally {
            // the up command removes it; this covers an upload or a command that did not get that far
            await host.exec(`rm -f ${TAILNET_AUTH_KEY_FILE}`, { timeoutMs: 15_000 }).catch(() => undefined);
          }
          if (failed) {
            // a daemon from before (maybe stuck in an old state): once more from a clean start
            if (!started && restarts === 0) { await restart(failed); continue; }
            return down(`${failed} (check the auth key in the vault, that it is reusable and not expired, and that the tailnet's ACL lets ${ref.tags.length ? ref.tags.join(", ") : "this node"} join)`);
          }
          ins = await look();
        }
        if (ins.forwarder && ins.target === target && ins.tunnel === true && ins.probe === false) {
          // the tunnel works but the forwarder does not relay: only the forwarder starts again
          await run(TAILNET_FORWARDER_STOP_COMMAND, 30_000);
          ins = { ...ins, forwarder: false };
        }
        if (!ins.forwarder || ins.target !== target || ins.fwdv2 === false) {
          await host.writeFile(TAILNET_FORWARDER_FILE, enc(TAILNET_FORWARDER_SCRIPT));
          if (!ins.forwarder || ins.target !== target) {
            const r = await run(tailnetForwarderCommand(ref.proxyHost, ref.proxyPort), 30_000);
            if (r.exitCode !== 0) return down(`The tailnet forwarder could not start: ${why(r)}`, describeTailnet(ins.status, ref.proxyHost));
          }
          ins = await look();
        }
        const desc = describeTailnet(ins.status, ref.proxyHost);
        const reachable = desc.tailnet === "up" && answers(ins);
        // still no answer from a node that looks stale: one clean restart, then a last look
        const staleNow = reachable || restarts > 0 ? undefined : tailnetStaleReason(ins.status);
        if (staleNow) { await restart(staleNow); continue; }
        if (reachable) return { computerId: ref.computerId, ...desc, proxyReachable: true, checkedAt };
        const problem = desc.tailnet !== "up"
          ? "The tailnet is not up yet"
          : `The proxy ${target} does not answer through the tailnet (its machine may be off, or the ACL does not allow this node)`;
        const stillStale = tailnetStaleReason(ins.status);
        return rejoinReason
          ? down(stillStale ? `${problem}; the node is still stale (${stillStale})` : problem, desc)
          : { computerId: ref.computerId, ...desc, proxyReachable: false, checkedAt, error: problem };
      }
    } catch (err) {
      return down(mask((err as Error).message ?? String(err)));
    }
  }
}

/** One runtime per process: the browser tools, the computers' start hook and the status share it. */
export const tailnetEgress = new TailnetEgress();

/**
 * A computer started, resumed or was created: its daemons may be gone, or (a resume from a memory
 * snapshot, Daytona v2 hibernation, a paused VM) back from before the sleep with a node the
 * tailnet has removed. Forget its last check, mark it restored (a tailscaled found alive is
 * restarted and joins again) and, when it goes out through the tailnet, bring the tailnet up in
 * the background (the browser waits for it anyway on its next use).
 */
export function onComputerStarted(computer: { id: string; kind: string; egress?: string }, host: TailnetHost): void {
  tailnetEgress.invalidate(computer.id, { restored: true });
  const egress = computer.egress ? egressFor?.(computer) : undefined;
  if (!egress?.tailnet) return;
  void tailnetEgress.ensure(host, egress.tailnet).catch(() => undefined);
}
