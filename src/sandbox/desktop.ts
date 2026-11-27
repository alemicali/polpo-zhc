/**
 * A computer's desktop: a virtual display in its VM that a person can watch live and take control
 * of (a login, 2FA, a CAPTCHA), like the agent computers of other assistants.
 *
 * In the VM (everything in DESKTOP_DIR, 0700, under /tmp):
 *   - Xvfb on DESKTOP_DISPLAY (:99, no TCP) and openbox: the display agents' headed browsers open
 *     their window on (browserHeaded). Started on demand by the browser itself or by the live view;
 *   - x11vnc on 127.0.0.1:DESKTOP_VNC_PORT only, with ONE password from the command's environment,
 *     read from a file x11vnc deletes right after (`rm:`): never on a command line, never on disk
 *     afterwards. It does not change when control changes hands (nothing restarts);
 *   - websockify on 0.0.0.0:DESKTOP_WS_PORT → the VNC port: what the provider's preview link
 *     reaches (Daytona v2 signed links carry their token; VNC still asks its password).
 *
 * Missing packages (a VM from an older image) are installed once with apt-get, idempotently; the
 * runner image polpo-runner-vm-4 ships them (scripts/build-sandbox-images.mjs).
 *
 * The server side (ComputerDesktops) starts and stops the live view and keeps the password: in
 * memory, and in the vault (reserved owner "$desktop", encrypted at rest, keyed by computer) so a
 * restarted server re-attaches to a desktop that still runs without restarting x11vnc. The Polpo
 * server answers the VNC Authentication itself (rfb-proxy.ts): the password never reaches a
 * browser, an event or a tool result; input passes only for the person holding the computer.
 */
import { randomInt } from "node:crypto";
import { isRemoteComputer, type ComputerConfig, type EffectiveSandbox } from "@polpo-ai/core/sandbox";
import type { VaultStore } from "@polpo-ai/core";
import type { ComputerManager } from "./computers.js";
import type { RemoteDriver, RemotePortEndpoint } from "./remote-adapters.js";

export const DESKTOP_DIR = "/tmp/polpo-desktop";
export const DESKTOP_DISPLAY = ":99";
export const DESKTOP_SCREEN = "1280x800x24";
export const DESKTOP_VNC_PORT = 5900;
export const DESKTOP_WS_PORT = 6080;
/** The environment variable the VNC password travels in (never a command line). */
export const DESKTOP_PASSWORD_ENV = "POLPO_VNC_PASSWORD";
/** Vault namespace of the live views' VNC passwords (reserved: "$" owners are never agents). */
export const DESKTOP_VAULT_OWNER = "$desktop";

const X_SOCKET = `/tmp/.X11-unix/X${DESKTOP_DISPLAY.slice(1)}`;

/** Debian packages: the display (headed browsers) and the live view on top. */
export const DESKTOP_DISPLAY_PACKAGES: Readonly<Record<string, string>> = { Xvfb: "xvfb", openbox: "openbox" };
export const DESKTOP_VIEW_PACKAGES: Readonly<Record<string, string>> = { ...DESKTOP_DISPLAY_PACKAGES, x11vnc: "x11vnc", websockify: "websockify", xdotool: "xdotool" };

const COMMON =
  `D=${DESKTOP_DIR}; mkdir -p "$D"; chmod 700 "$D"; `
  + `alive() { [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; }; `
  + `S=$(command -v setsid 2>/dev/null || true); `;

/**
 * Install what is missing (apt-get, with sudo when not root), only the binaries not found: a no-op
 * (one `command -v` each) on the runner image.
 */
export function desktopInstallCommand(what: "display" | "view"): string {
  const pkgs = what === "view" ? DESKTOP_VIEW_PACKAGES : DESKTOP_DISPLAY_PACKAGES;
  return COMMON
    + `need=""; `
    + Object.entries(pkgs).map(([bin, pkg]) => `command -v ${bin} >/dev/null 2>&1 || need="$need ${pkg}"; `).join("")
    + `[ -z "$need" ] && exit 0; `
    + `SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"; `
    + `$SUDO sh -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $need" >"$D/install.log" 2>&1 `
    + `|| { echo "could not install$need: $(tail -c 500 "$D/install.log" 2>/dev/null)" >&2; exit 1; }`;
}

/** The display (Xvfb + openbox), started when it is not up: idempotent, fast when it runs. */
export const DESKTOP_DISPLAY_COMMAND = COMMON
  + `if ! { [ -S ${X_SOCKET} ] && { alive "$D/xvfb.pid" || pgrep -f 'Xvfb ${DESKTOP_DISPLAY}' >/dev/null 2>&1; }; }; then `
  + `command -v Xvfb >/dev/null 2>&1 || { echo "Xvfb is not installed" >&2; exit 2; }; `
  + `rm -f ${X_SOCKET} /tmp/.X${DESKTOP_DISPLAY.slice(1)}-lock; `
  + `$S nohup Xvfb ${DESKTOP_DISPLAY} -screen 0 ${DESKTOP_SCREEN} -nolisten tcp -ac >"$D/xvfb.log" 2>&1 </dev/null & echo $! >"$D/xvfb.pid"; `
  + `i=0; while [ $i -lt 50 ] && [ ! -S ${X_SOCKET} ]; do sleep 0.1; i=$((i+1)); done; `
  + `[ -S ${X_SOCKET} ] || { echo "the virtual display did not start: $(tail -c 300 "$D/xvfb.log" 2>/dev/null)" >&2; exit 1; }; fi; `
  + `if command -v openbox >/dev/null 2>&1 && ! alive "$D/wm.pid"; then DISPLAY=${DESKTOP_DISPLAY} $S nohup openbox >"$D/wm.log" 2>&1 </dev/null & echo $! >"$D/wm.pid"; fi; true`;

/** A TCP port answers on 127.0.0.1 (node is in every runner image). */
const portAnswers = (port: number) =>
  `node -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" >/dev/null 2>&1`;

/**
 * x11vnc's options besides the display, port and password:
 * - `-localhost -shared -forever`: only websockify reaches it, every viewer on one session;
 * - `-cursor arrow`: a visible arrow (the cursor shape goes to the viewer, noVNC draws it);
 * - `-noncache`: no client-side cache (its extra framebuffer area confuses noVNC);
 * - `-wait 10 -defer 10`: poll the display and send updates every 10 ms (default 20-30);
 * - `-nowf`: windows move as they are, not as wireframes;
 * - `-noxdamage` (kept): on Xvfb, DAMAGE hints can miss parts of what a browser paints; polling
 *   (every `-wait` ms) never does;
 * - `-repeat`: key autorepeat for the person typing.
 */
export const DESKTOP_VNC_OPTIONS = "-cursor arrow -noncache -wait 10 -defer 10 -nowf -noxdamage -repeat -quiet";

/**
 * The live view (needs the display): x11vnc local only with ONE password from the environment
 * (the Polpo server answers its VNC Authentication: rfb-proxy.ts; viewers never see it), started
 * when it is not running or when `restart` (a new password), and websockify on 0.0.0.0.
 */
export function desktopViewCommand(o: { restart: boolean }): string {
  return COMMON
    + `[ -n "$${DESKTOP_PASSWORD_ENV}" ] || { echo "no VNC password" >&2; exit 2; }; `
    + `command -v x11vnc >/dev/null 2>&1 || { echo "x11vnc is not installed" >&2; exit 2; }; `
    + `command -v websockify >/dev/null 2>&1 || { echo "websockify is not installed" >&2; exit 2; }; `
    + `if [ "${o.restart ? 1 : 0}" = 1 ] || ! alive "$D/vnc.pid"; then `
    + `if alive "$D/vnc.pid"; then kill "$(cat "$D/vnc.pid")" 2>/dev/null; i=0; while [ $i -lt 50 ] && alive "$D/vnc.pid"; do sleep 0.1; i=$((i+1)); done; `
    // an old server still answering would keep the old password: never leave it running
    + `alive "$D/vnc.pid" && kill -9 "$(cat "$D/vnc.pid")" 2>/dev/null; i=0; while [ $i -lt 20 ] && ${portAnswers(DESKTOP_VNC_PORT)}; do sleep 0.1; i=$((i+1)); done; fi; `
    + `(umask 077; printf '%s\\n' "$${DESKTOP_PASSWORD_ENV}" >"$D/vnc.pass"); `
    + `DISPLAY=${DESKTOP_DISPLAY} $S nohup x11vnc -display ${DESKTOP_DISPLAY} -rfbport ${DESKTOP_VNC_PORT} -localhost -forever -shared `
    + `-passwdfile "rm:$D/vnc.pass" ${DESKTOP_VNC_OPTIONS} >"$D/vnc.log" 2>&1 </dev/null & echo $! >"$D/vnc.pid"; `
    + `i=0; while [ $i -lt 50 ] && ! ${portAnswers(DESKTOP_VNC_PORT)}; do sleep 0.1; i=$((i+1)); done; `
    + `${portAnswers(DESKTOP_VNC_PORT)} || { rm -f "$D/vnc.pass"; echo "the VNC server did not start: $(tail -c 300 "$D/vnc.log" 2>/dev/null)" >&2; exit 1; }; fi; `
    + `if ! alive "$D/ws.pid"; then $S nohup websockify 0.0.0.0:${DESKTOP_WS_PORT} 127.0.0.1:${DESKTOP_VNC_PORT} >"$D/ws.log" 2>&1 </dev/null & echo $! >"$D/ws.pid"; `
    + `i=0; while [ $i -lt 50 ] && ! ${portAnswers(DESKTOP_WS_PORT)}; do sleep 0.1; i=$((i+1)); done; `
    + `${portAnswers(DESKTOP_WS_PORT)} || { echo "websockify did not start: $(tail -c 300 "$D/ws.log" 2>/dev/null)" >&2; exit 1; }; fi; true`;
}

/** What runs: one `key=0|1` line each. */
export const DESKTOP_INSPECT_COMMAND = COMMON
  + `if [ -S ${X_SOCKET} ] && { alive "$D/xvfb.pid" || pgrep -f 'Xvfb ${DESKTOP_DISPLAY}' >/dev/null 2>&1; }; then echo display=1; else echo display=0; fi; `
  + `if alive "$D/wm.pid"; then echo wm=1; else echo wm=0; fi; `
  + `if alive "$D/vnc.pid"; then echo vnc=1; else echo vnc=0; fi; `
  + `if alive "$D/ws.pid"; then echo ws=1; else echo ws=0; fi; `
  + `if command -v x11vnc >/dev/null 2>&1 && command -v websockify >/dev/null 2>&1; then echo installed=1; else echo installed=0; fi; true`;

/** Stop the live view (VNC and websockify); the display stays (a headed browser lives on it). */
export const DESKTOP_STOP_COMMAND = COMMON
  + `for p in ws vnc; do alive "$D/$p.pid" && kill "$(cat "$D/$p.pid")" 2>/dev/null; rm -f "$D/$p.pid"; done; rm -f "$D/vnc.pass"; true`;

export interface DesktopProcesses { display: boolean; wm: boolean; vnc: boolean; ws: boolean; installed: boolean }

export function parseDesktopInspect(stdout: string): DesktopProcesses {
  const v = (k: string) => new RegExp(`^${k}=1$`, "m").test(stdout);
  return { display: v("display"), wm: v("wm"), vnc: v("vnc"), ws: v("ws"), installed: v("installed") };
}

/** A command runner on the VM (a RemoteDriver, or the agent's workspace shell). */
export interface DesktopHost {
  exec(command: string, o?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** The display up in the VM (installing Xvfb/openbox when missing): undefined, else why not. */
export async function ensureDesktopDisplay(host: DesktopHost): Promise<string | undefined> {
  const installed = await host.exec(desktopInstallCommand("display"), { timeoutMs: INSTALL_TIMEOUT_MS }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String((err as Error)?.message ?? err) }));
  if (installed.exitCode !== 0) return `The virtual display cannot be installed: ${(installed.stderr || installed.stdout).trim().slice(0, 400)}`;
  const up = await host.exec(DESKTOP_DISPLAY_COMMAND, { timeoutMs: 30_000 }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String((err as Error)?.message ?? err) }));
  return up.exitCode === 0 ? undefined : `The virtual display did not start: ${(up.stderr || up.stdout).trim().slice(0, 400)}`;
}

/** A VNC password: 8 characters (what VNC authentication uses), no look-alikes. */
export function vncPassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[randomInt(chars.length)];
  return out;
}

export type DesktopState = "running" | "stopped" | "machine-off" | "unsupported";

/** A computer's desktop as the API shows it (never its password). */
export interface DesktopStatus {
  computerId: string;
  state: DesktopState;
  /** The display headed browsers use. */
  display: string;
  processes?: DesktopProcesses;
  /** Why it cannot run here (host computer, provider without ports). */
  note?: string;
  error?: string;
  startedAt?: string;
}

interface Session { password: string; remoteId?: string; startedAt: string }

export interface ComputerDesktopsDeps {
  manager: () => ComputerManager;
  sandboxFor: (computer: ComputerConfig) => EffectiveSandbox | { error: string };
  /** Where the password survives a restart (encrypted, owner "$desktop"); without it, memory only. */
  vault?: () => VaultStore | undefined;
}

/** Why a computer has no desktop here (undefined: it can have one). */
export function desktopUnsupported(computer: ComputerConfig): string | undefined {
  if (!isRemoteComputer(computer)) return `"${computer.id}" is this server: its browser's live view is Browser Live (/agent-browser)`;
  if (computer.kind !== "daytona") return `Computer "${computer.id}" (${computer.kind}): the live view needs a Daytona v2 computer (its VM exposes ports to Polpo)`;
  return undefined;
}

/**
 * The live views of a project's computers (server process). The password of each is set when its
 * x11vnc starts and kept in memory and in the vault: a restarted server re-attaches to a desktop
 * still running on the same VM; a new VM (or a password the VNC server refuses) gets a new one.
 */
export class ComputerDesktops {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: ComputerDesktopsDeps) {}

  private driverFor(computer: ComputerConfig): Promise<RemoteDriver> {
    const sandbox = this.deps.sandboxFor(computer);
    if ("error" in sandbox) throw new Error(sandbox.error);
    return this.deps.manager().attach(computer, sandbox);
  }

  /** The password this server knows for the desktop of `remoteId` (memory, else the vault). */
  private async remembered(computerId: string, remoteId: string | undefined): Promise<Session | undefined> {
    const s = this.sessions.get(computerId);
    if (s) {
      if (s.remoteId === remoteId) return s;
      this.forget(computerId); // another VM: its x11vnc never had this password
      return undefined;
    }
    const entry = await this.deps.vault?.()?.get(DESKTOP_VAULT_OWNER, computerId).catch(() => undefined);
    const c = entry?.credentials;
    if (!c?.password || (c.remoteId || undefined) !== remoteId) return undefined;
    const kept: Session = { password: c.password, ...(remoteId ? { remoteId } : {}), startedAt: c.startedAt || new Date().toISOString() };
    this.sessions.set(computerId, kept);
    return kept;
  }

  private async persist(computerId: string, s: Session): Promise<void> {
    await this.deps.vault?.()?.set(DESKTOP_VAULT_OWNER, computerId, {
      type: "custom",
      label: `Live view of computer ${computerId} (VNC password, server only)`,
      credentials: { password: s.password, remoteId: s.remoteId ?? "", startedAt: s.startedAt },
    }).catch(() => undefined);
  }

  /** Forget a computer's password (memory and vault): the next start sets a new one. */
  forget(computerId: string): void {
    this.sessions.delete(computerId);
    void this.deps.vault?.()?.remove(DESKTOP_VAULT_OWNER, computerId).catch(() => false);
  }

  /** The VNC server refused the password: forgotten, so the next start restarts it with a new one. */
  invalidate(computerId: string): void {
    this.forget(computerId);
  }

  /**
   * What runs on its VM now; never starts or wakes it. A live view still running on the same VM
   * (a server restart) is re-attached with the password kept in the vault.
   */
  async status(computer: ComputerConfig): Promise<DesktopStatus> {
    const base = { computerId: computer.id, display: DESKTOP_DISPLAY };
    const unsupported = desktopUnsupported(computer);
    if (unsupported) return { ...base, state: "unsupported", note: unsupported };
    try {
      const r = await this.deps.manager().whenRunning(computer, async (d) => ({ out: await d.exec(DESKTOP_INSPECT_COMMAND, { timeoutMs: 20_000 }), remoteId: d.remoteId }));
      if (!r) return { ...base, state: "machine-off", note: "Its machine is not running: starting the live view starts it" };
      const processes = parseDesktopInspect(r.out.stdout);
      const s = processes.vnc && processes.ws ? await this.remembered(computer.id, r.remoteId) : undefined;
      if (s) return { ...base, state: "running", processes, startedAt: s.startedAt };
      return {
        ...base, state: "stopped", processes,
        ...(processes.vnc && processes.ws ? { note: "Its VNC server runs with a password this server does not know: starting the live view restarts it" } : {}),
      };
    } catch (err) {
      return { ...base, state: "stopped", error: (err as Error).message };
    }
  }

  /**
   * Start the live view (starting or waking the computer): install what is missing, the display,
   * then VNC (restarted with a new password only when this server knows none for this VM) and
   * websockify. Idempotent: a running live view keeps its password and its viewers.
   */
  async start(computer: ComputerConfig): Promise<DesktopStatus> {
    const unsupported = desktopUnsupported(computer);
    if (unsupported) throw new Error(unsupported);
    const driver = await this.driverFor(computer);
    const host: DesktopHost = { exec: (cmd, x = {}) => driver.exec(cmd, { ...(x.env ? { env: x.env } : {}), ...(x.timeoutMs ? { timeoutMs: x.timeoutMs } : {}) }) };
    const install = await host.exec(desktopInstallCommand("view"), { timeoutMs: INSTALL_TIMEOUT_MS });
    if (install.exitCode !== 0) throw new Error(`The desktop cannot be installed on computer "${computer.id}": ${(install.stderr || install.stdout).trim().slice(0, 400)}`);
    const display = await host.exec(DESKTOP_DISPLAY_COMMAND, { timeoutMs: 30_000 });
    if (display.exitCode !== 0) throw new Error(`The virtual display did not start on computer "${computer.id}": ${(display.stderr || display.stdout).trim().slice(0, 400)}`);
    const known = await this.remembered(computer.id, driver.remoteId);
    const s: Session = known ?? { password: vncPassword(), ...(driver.remoteId ? { remoteId: driver.remoteId } : {}), startedAt: new Date().toISOString() };
    const view = await host.exec(desktopViewCommand({ restart: !known }), { timeoutMs: 30_000, env: { [DESKTOP_PASSWORD_ENV]: s.password } });
    if (view.exitCode !== 0) {
      this.forget(computer.id);
      throw new Error(`The live view did not start on computer "${computer.id}": ${(view.stderr || view.stdout).trim().slice(0, 400)}`);
    }
    this.sessions.set(computer.id, s);
    if (!known) await this.persist(computer.id, s);
    return { computerId: computer.id, display: DESKTOP_DISPLAY, state: "running", startedAt: s.startedAt };
  }

  /** Stop the live view (the display and its browser windows stay). Never starts the computer. */
  async stop(computer: ComputerConfig): Promise<DesktopStatus> {
    this.forget(computer.id);
    if (!desktopUnsupported(computer)) {
      await this.deps.manager().whenRunning(computer, (d) => d.exec(DESKTOP_STOP_COMMAND, { timeoutMs: 20_000 })).catch(() => undefined);
    }
    return this.status(computer);
  }

  /** The VNC password (server side only: the RFB proxy answers the VM with it). */
  password(computerId: string): string | undefined {
    return this.sessions.get(computerId)?.password;
  }

  /** Whether the live view runs and this server knows its password (re-attaching after a restart). */
  async attached(computer: ComputerConfig): Promise<boolean> {
    if (this.sessions.has(computer.id)) return true;
    return (await this.status(computer)).state === "running";
  }

  /** websockify through the provider's preview link (a signed link: its token in the URL). */
  async endpoint(computer: ComputerConfig): Promise<RemotePortEndpoint> {
    const driver = await this.driverFor(computer);
    if (!driver.portEndpoint) throw new Error(`Computer "${computer.id}" exposes no ports to this server (the live view needs a Daytona v2 computer)`);
    return driver.portEndpoint(DESKTOP_WS_PORT, { protocol: "ws", ttlSeconds: 3600 });
  }

  /** Keep the computer in use while a viewer is connected (no idle hibernation under a person). */
  hold(computer: ComputerConfig): () => void {
    return this.deps.manager().hold(computer);
  }
}

const desktops = new Map<string, ComputerDesktops>();

/** The live views of a .polpo directory (one per server process). */
export function computerDesktopsFor(polpoDir: string, deps: ComputerDesktopsDeps): ComputerDesktops {
  let d = desktops.get(polpoDir);
  if (!d) desktops.set(polpoDir, (d = new ComputerDesktops(deps)));
  return d;
}

/** Tests: replace (or drop) the live views of a .polpo directory. */
export function setComputerDesktops(polpoDir: string, d: ComputerDesktops | undefined): void {
  if (d) desktops.set(polpoDir, d);
  else desktops.delete(polpoDir);
}
