/**
 * A computer's desktop: a virtual display in its VM that a person can watch live and take control
 * of (a login, 2FA, a CAPTCHA), like the agent computers of other assistants.
 *
 * In the VM (everything in DESKTOP_DIR, 0700, under /tmp):
 *   - Xvfb on DESKTOP_DISPLAY (:99, no TCP) and openbox: the display agents' headed browsers open
 *     their window on (browserHeaded). Started on demand by the browser itself or by the live view;
 *   - x11vnc on 127.0.0.1:DESKTOP_VNC_PORT only, with two passwords (full control, view-only) from
 *     the command's environment, read from a file x11vnc deletes right after (`rm:`): never on a
 *     command line, never on disk afterwards. They change whenever control changes hands (x11vnc
 *     restarts, open viewers reconnect with the password their role allows);
 *   - websockify on 0.0.0.0:DESKTOP_WS_PORT → the VNC port: what the provider's preview link
 *     reaches (Daytona v2 signed links carry their token; VNC still asks its password).
 *
 * Missing packages (a VM from an older image) are installed once with apt-get, idempotently; the
 * runner image polpo-runner-vm-4 ships them (scripts/build-sandbox-images.mjs).
 *
 * The server side (ComputerDesktops) starts and stops the live view, keeps the passwords in memory
 * (never in a file, never in events or tool results) and gives the person's viewer the password
 * their role allows: full control only to the person holding the computer (computer-control.ts).
 */
import { randomInt } from "node:crypto";
import { isRemoteComputer, type ComputerConfig, type EffectiveSandbox } from "@polpo-ai/core/sandbox";
import type { ComputerManager } from "./computers.js";
import type { RemoteDriver, RemotePortEndpoint } from "./remote-adapters.js";

export const DESKTOP_DIR = "/tmp/polpo-desktop";
export const DESKTOP_DISPLAY = ":99";
export const DESKTOP_SCREEN = "1280x800x24";
export const DESKTOP_VNC_PORT = 5900;
export const DESKTOP_WS_PORT = 6080;
/** The environment variables the view's passwords travel in (never a command line). */
export const DESKTOP_PASSWORD_ENV = "POLPO_VNC_PASSWORD";
export const DESKTOP_VIEW_PASSWORD_ENV = "POLPO_VNC_VIEW_PASSWORD";

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
 * The live view (needs the display): x11vnc local only with the passwords from the environment
 * (restarted when `rotate`, or when it is not running), and websockify on 0.0.0.0.
 */
export function desktopViewCommand(o: { rotate: boolean }): string {
  return COMMON
    + `[ -n "$${DESKTOP_PASSWORD_ENV}" ] && [ -n "$${DESKTOP_VIEW_PASSWORD_ENV}" ] || { echo "no VNC password" >&2; exit 2; }; `
    + `command -v x11vnc >/dev/null 2>&1 || { echo "x11vnc is not installed" >&2; exit 2; }; `
    + `command -v websockify >/dev/null 2>&1 || { echo "websockify is not installed" >&2; exit 2; }; `
    + `if [ "${o.rotate ? 1 : 0}" = 1 ] || ! alive "$D/vnc.pid"; then `
    + `if alive "$D/vnc.pid"; then kill "$(cat "$D/vnc.pid")" 2>/dev/null; i=0; while [ $i -lt 20 ] && alive "$D/vnc.pid"; do sleep 0.1; i=$((i+1)); done; fi; `
    + `(umask 077; printf '%s\\n__BEGIN_VIEWONLY__\\n%s\\n' "$${DESKTOP_PASSWORD_ENV}" "$${DESKTOP_VIEW_PASSWORD_ENV}" >"$D/vnc.pass"); `
    + `DISPLAY=${DESKTOP_DISPLAY} $S nohup x11vnc -display ${DESKTOP_DISPLAY} -rfbport ${DESKTOP_VNC_PORT} -localhost -forever -shared `
    + `-passwdfile "rm:$D/vnc.pass" -noxdamage -repeat -quiet >"$D/vnc.log" 2>&1 </dev/null & echo $! >"$D/vnc.pid"; `
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

/** A computer's desktop as the API shows it (never its passwords). */
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

interface Session { full: string; view: string; remoteId?: string; startedAt: string }

export interface ComputerDesktopsDeps {
  manager: () => ComputerManager;
  sandboxFor: (computer: ComputerConfig) => EffectiveSandbox | { error: string };
}

/** Why a computer has no desktop here (undefined: it can have one). */
export function desktopUnsupported(computer: ComputerConfig): string | undefined {
  if (!isRemoteComputer(computer)) return `"${computer.id}" is this server: its browser's live view is Browser Live (/agent-browser)`;
  if (computer.kind !== "daytona") return `Computer "${computer.id}" (${computer.kind}): the live view needs a Daytona v2 computer (its VM exposes ports to Polpo)`;
  return undefined;
}

/**
 * The live views of a project's computers (server process). Passwords stay in memory: after a
 * restart, the next start sets new ones.
 */
export class ComputerDesktops {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly deps: ComputerDesktopsDeps) {}

  private driverFor(computer: ComputerConfig): Promise<RemoteDriver> {
    const sandbox = this.deps.sandboxFor(computer);
    if ("error" in sandbox) throw new Error(sandbox.error);
    return this.deps.manager().attach(computer, sandbox);
  }

  /** What runs on its VM now; never starts or wakes it. */
  async status(computer: ComputerConfig): Promise<DesktopStatus> {
    const base = { computerId: computer.id, display: DESKTOP_DISPLAY };
    const unsupported = desktopUnsupported(computer);
    if (unsupported) return { ...base, state: "unsupported", note: unsupported };
    try {
      const r = await this.deps.manager().whenRunning(computer, (d) => d.exec(DESKTOP_INSPECT_COMMAND, { timeoutMs: 20_000 }));
      if (!r) return { ...base, state: "machine-off", note: "Its machine is not running: starting the live view starts it" };
      const processes = parseDesktopInspect(r.stdout);
      const s = this.sessions.get(computer.id);
      const running = processes.vnc && processes.ws && !!s;
      return { ...base, state: running ? "running" : "stopped", processes, ...(running && s ? { startedAt: s.startedAt } : {}) };
    } catch (err) {
      return { ...base, state: "stopped", error: (err as Error).message };
    }
  }

  /**
   * Start the live view (starting or waking the computer): install what is missing, the display,
   * then VNC (new passwords when it has none here, its VM changed, or `rotate`) and websockify.
   */
  async start(computer: ComputerConfig, o: { rotate?: boolean } = {}): Promise<DesktopStatus> {
    const unsupported = desktopUnsupported(computer);
    if (unsupported) throw new Error(unsupported);
    const driver = await this.driverFor(computer);
    const host: DesktopHost = { exec: (cmd, x = {}) => driver.exec(cmd, { ...(x.env ? { env: x.env } : {}), ...(x.timeoutMs ? { timeoutMs: x.timeoutMs } : {}) }) };
    const install = await host.exec(desktopInstallCommand("view"), { timeoutMs: INSTALL_TIMEOUT_MS });
    if (install.exitCode !== 0) throw new Error(`The desktop cannot be installed on computer "${computer.id}": ${(install.stderr || install.stdout).trim().slice(0, 400)}`);
    const display = await host.exec(DESKTOP_DISPLAY_COMMAND, { timeoutMs: 30_000 });
    if (display.exitCode !== 0) throw new Error(`The virtual display did not start on computer "${computer.id}": ${(display.stderr || display.stdout).trim().slice(0, 400)}`);
    let s = this.sessions.get(computer.id);
    const rotate = !!o.rotate || !s || s.remoteId !== driver.remoteId;
    if (rotate) s = { full: vncPassword(), view: vncPassword(), remoteId: driver.remoteId, startedAt: new Date().toISOString() };
    const view = await host.exec(desktopViewCommand({ rotate }), {
      timeoutMs: 30_000, env: { [DESKTOP_PASSWORD_ENV]: s!.full, [DESKTOP_VIEW_PASSWORD_ENV]: s!.view },
    });
    if (view.exitCode !== 0) {
      this.sessions.delete(computer.id);
      throw new Error(`The live view did not start on computer "${computer.id}": ${(view.stderr || view.stdout).trim().slice(0, 400)}`);
    }
    this.sessions.set(computer.id, s!);
    return { computerId: computer.id, display: DESKTOP_DISPLAY, state: "running", startedAt: s!.startedAt };
  }

  /** Stop the live view (the display and its browser windows stay). Never starts the computer. */
  async stop(computer: ComputerConfig): Promise<DesktopStatus> {
    this.sessions.delete(computer.id);
    if (!desktopUnsupported(computer)) {
      await this.deps.manager().whenRunning(computer, (d) => d.exec(DESKTOP_STOP_COMMAND, { timeoutMs: 20_000 })).catch(() => undefined);
    }
    return this.status(computer);
  }

  /**
   * Control changed hands: new passwords (open viewers are cut and reconnect with what their role
   * allows). Only when the live view runs here; never starts the computer.
   */
  async rotate(computer: ComputerConfig): Promise<void> {
    if (!this.sessions.has(computer.id) || desktopUnsupported(computer)) return;
    const running = await this.deps.manager().whenRunning(computer, async () => true).catch(() => undefined);
    if (!running) { this.sessions.delete(computer.id); return; }
    await this.start(computer, { rotate: true }).catch(() => { this.sessions.delete(computer.id); });
  }

  /** The password for a viewer: full control or view-only (undefined: the live view is not started here). */
  password(computerId: string, mode: "control" | "view"): string | undefined {
    const s = this.sessions.get(computerId);
    return s ? (mode === "control" ? s.full : s.view) : undefined;
  }

  /** Whether this server started the live view (and knows its passwords). */
  started(computerId: string): boolean {
    return this.sessions.has(computerId);
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
