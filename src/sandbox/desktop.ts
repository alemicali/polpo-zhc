/**
 * A computer's desktop: a virtual display in its VM that a person can watch live and take control
 * of (a login, 2FA, a CAPTCHA), like the agent computers of other assistants.
 *
 * In the VM (everything in DESKTOP_DIR, 0700, under /tmp):
 *   - Xvfb on DESKTOP_DISPLAY (:99, no TCP; 1280x800 or the computer's desktop.size) with an XFCE
 *     session (panel, menu, Thunar, terminal, Mousepad, task manager; no screensaver, no locking,
 *     no compositing; the agent's language, timezone and keyboard layout), openbox only when XFCE
 *     cannot be installed: the desktop agents' headed browsers open their window on
 *     (browserHeaded), with a "Chrome di <agent>" launcher each (agent-chrome.ts). Started on
 *     demand by the browser itself or by the live view;
 *   - x11vnc on 127.0.0.1:DESKTOP_VNC_PORT only, with ONE password from the command's environment,
 *     read from a file x11vnc deletes right after (`rm:`): never on a command line, never on disk
 *     afterwards. It does not change when control changes hands (nothing restarts);
 *   - websockify on 0.0.0.0:DESKTOP_WS_PORT → the VNC port: what the provider's preview link
 *     reaches (Daytona v2 signed links carry their token; VNC still asks its password).
 *
 * Missing packages (a VM from an older image) are installed once with apt-get (no recommends),
 * idempotently; the runner image polpo-runner-vm-4 ships them (scripts/build-sandbox-images.mjs).
 * The clipboard goes both ways through x11vnc (xclip/xsel are there for agents' scripts).
 *
 * The server side (ComputerDesktops) starts and stops the live view and keeps the password: in
 * memory, and in the vault (reserved owner "$desktop", encrypted at rest, keyed by computer) so a
 * restarted server re-attaches to a desktop that still runs without restarting x11vnc. The Polpo
 * server answers the VNC Authentication itself (rfb-proxy.ts): the password never reaches a
 * browser, an event or a tool result; input passes only for the person holding the computer.
 */
import { randomInt } from "node:crypto";
import {
  DEFAULT_COMPUTER_DESKTOP_SIZE, computerDesktopSize, computerUsers, isRemoteComputer, parseDesktopSize, type ComputerConfig, type EffectiveSandbox,
} from "@polpo-ai/core/sandbox";
import type { VaultStore } from "@polpo-ai/core";
import type { ComputerManager } from "./computers.js";
import type { RemoteDriver, RemotePortEndpoint } from "./remote-adapters.js";

export const DESKTOP_DIR = "/tmp/polpo-desktop";
export const DESKTOP_DISPLAY = ":99";
/** The default screen (Xvfb's -screen 0): settings.computers[].desktop.size changes it per computer. */
export const DESKTOP_SCREEN = `${DEFAULT_COMPUTER_DESKTOP_SIZE}x24`;
export const DESKTOP_VNC_PORT = 5900;
export const DESKTOP_WS_PORT = 6080;
/** The environment variable the VNC password travels in (never a command line). */
export const DESKTOP_PASSWORD_ENV = "POLPO_VNC_PASSWORD";
/** Vault namespace of the live views' VNC passwords (reserved: "$" owners are never agents). */
export const DESKTOP_VAULT_OWNER = "$desktop";

const X_SOCKET = `/tmp/.X11-unix/X${DESKTOP_DISPLAY.slice(1)}`;

/**
 * Debian packages, by the binary that shows they are there: the display itself (headed browsers),
 * the keyboard layout and the clipboard tools. Required: no display without them.
 */
export const DESKTOP_DISPLAY_PACKAGES: Readonly<Record<string, string>> = {
  Xvfb: "xvfb", setxkbmap: "x11-xkb-utils", xset: "x11-xserver-utils", xclip: "xclip", xsel: "xsel",
};
/**
 * The XFCE desktop (a real PC desktop: panel, menu, file manager, terminal, editor, task manager),
 * by binary. Installed without recommends (no xfce4-goodies, no screensaver, no power manager).
 */
export const DESKTOP_XFCE_PACKAGES: Readonly<Record<string, string>> = {
  startxfce4: "xfce4", "xfce4-terminal": "xfce4-terminal", thunar: "thunar", mousepad: "mousepad",
  "xfce4-taskmanager": "xfce4-taskmanager", "dbus-launch": "dbus-x11",
};
/** XFCE's companions without a binary of their own (checked with dpkg): accessibility bus, fonts, icons, locales, timezones. */
export const DESKTOP_XFCE_EXTRA_PACKAGES: readonly string[] = [
  "at-spi2-core", "fonts-dejavu", "fonts-liberation", "tango-icon-theme", "adwaita-icon-theme", "librsvg2-common", "locales", "tzdata",
];
/** The window manager when XFCE cannot be installed (a VM without the packages and no apt mirror for them). */
export const DESKTOP_FALLBACK_PACKAGES: Readonly<Record<string, string>> = { openbox: "openbox" };
/** The live view on top of the display. */
export const DESKTOP_VIEW_PACKAGES: Readonly<Record<string, string>> = { ...DESKTOP_DISPLAY_PACKAGES, x11vnc: "x11vnc", websockify: "websockify", xdotool: "xdotool" };

/** Every Debian package of a full desktop (what the runner image installs: scripts/build-sandbox-images.mjs). */
export const DESKTOP_IMAGE_PACKAGES: readonly string[] = [
  ...new Set([...Object.values(DESKTOP_VIEW_PACKAGES), ...Object.values(DESKTOP_XFCE_PACKAGES), ...DESKTOP_XFCE_EXTRA_PACKAGES]),
];

/** How the desktop looks to a person: its size, and the language, timezone and keyboard of its session. */
export interface DesktopOptions {
  /** "WIDTHxHEIGHT" (default 1280x800): computer.desktop.size. */
  size?: string;
  /** BCP 47 (default it-IT): the agent's identity.locale. */
  locale?: string;
  /** IANA (default Europe/Rome): the agent's identity.timezone. */
  timezone?: string;
}

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/;
/** Keyboard layouts (setxkbmap) by language, region first: "en-GB" → gb, "en" → us. Default it. */
const KEYBOARDS: Readonly<Record<string, string>> = {
  it: "it", en: "us", "en-GB": "gb", "en-IE": "gb", de: "de", "de-CH": "ch", fr: "fr", "fr-CH": "ch", "fr-BE": "be", "fr-CA": "ca",
  es: "es", pt: "pt", "pt-BR": "br", nl: "nl", "nl-BE": "be", sv: "se", da: "dk", nb: "no", no: "no", fi: "fi", pl: "pl", cs: "cz",
  el: "gr", tr: "tr", ru: "ru", uk: "ua", ro: "ro", hu: "hu", ja: "jp", ko: "kr",
};
/** A glibc locale for a language with no region ("en" → en_US). */
const DEFAULT_REGION: Readonly<Record<string, string>> = { en: "US", da: "DK", sv: "SE", el: "GR", ja: "JP", ko: "KR", uk: "UA", cs: "CZ", nb: "NO" };

/** The session's settings from the desktop options: screen, LANG (UTF-8), TZ and keyboard layout. */
export function desktopSession(o: DesktopOptions = {}): { size: [number, number]; screen: string; lang: string; timezone: string; keyboard: string } {
  const size = parseDesktopSize(o.size) ?? parseDesktopSize(DEFAULT_COMPUTER_DESKTOP_SIZE)!;
  const locale = o.locale?.trim() && LOCALE_RE.test(o.locale.trim()) ? o.locale.trim() : "it-IT";
  const [language, region] = locale.split("-") as [string, string | undefined];
  const lang = language.toLowerCase();
  const reg = region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : DEFAULT_REGION[lang] ?? lang.toUpperCase();
  const timezone = o.timezone?.trim() && TIMEZONE_RE.test(o.timezone.trim()) ? o.timezone.trim() : "Europe/Rome";
  return {
    size, screen: `${size[0]}x${size[1]}x24`, lang: `${lang}_${reg}.UTF-8`, timezone,
    keyboard: KEYBOARDS[`${lang}-${reg}`] ?? KEYBOARDS[lang] ?? "it",
  };
}

const COMMON =
  `D=${DESKTOP_DIR}; mkdir -p "$D"; chmod 700 "$D"; `
  + `alive() { [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null; }; `
  + `S=$(command -v setsid 2>/dev/null || true); `;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const missingBins = (pkgs: Readonly<Record<string, string>>, into: string) =>
  Object.entries(pkgs).map(([bin, pkg]) => `command -v ${bin} >/dev/null 2>&1 || ${into}="$${into} ${pkg}"; `).join("");

/**
 * Install what is missing (apt-get, with sudo when not root, without recommends), only the
 * binaries (and XFCE's package-only companions) not found: a no-op on the runner image. XFCE comes
 * with the display; when it cannot be installed, openbox does instead (the desktop still works).
 */
export function desktopInstallCommand(what: "display" | "view"): string {
  const pkgs = what === "view" ? DESKTOP_VIEW_PACKAGES : DESKTOP_DISPLAY_PACKAGES;
  return COMMON
    + `need=""; desk=""; `
    + missingBins(pkgs, "need")
    + missingBins(DESKTOP_XFCE_PACKAGES, "desk")
    + `for p in ${DESKTOP_XFCE_EXTRA_PACKAGES.join(" ")}; do dpkg-query -W -f='\${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || desk="$desk $p"; done; `
    + `[ -z "$need$desk" ] && exit 0; `
    + `SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"; `
    + `inst() { [ -z "$(echo $1)" ] && return 0; $SUDO sh -c "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $1" >>"$D/install.log" 2>&1; }; `
    + `: >"$D/install.log"; $SUDO sh -c "apt-get update -qq" >>"$D/install.log" 2>&1; `
    + `if [ -n "$desk" ] && ! inst "$need $desk"; then `
    // no XFCE: openbox instead (a window manager, no panel), the display still comes up
    + `echo "XFCE could not be installed: openbox instead" >>"$D/install.log"; ${missingBins(DESKTOP_FALLBACK_PACKAGES, "need")}`
    + `inst "$need" || { echo "could not install$need: $(tail -c 500 "$D/install.log" 2>/dev/null)" >&2; exit 1; }; `
    + `elif [ -z "$desk" ]; then inst "$need" || { echo "could not install$need: $(tail -c 500 "$D/install.log" 2>/dev/null)" >&2; exit 1; }; fi; true`;
}

/** xfconf channels written on the first start (a person's later changes are kept): no compositing, no locking, no blanking, the keyboard layout. */
function xfconfFiles(keyboard: string): Record<string, string> {
  const ch = (name: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<channel name="${name}" version="1.0">\n${body}\n</channel>`;
  return {
    // no compositing: what VNC sends stays cheap (no shadows, no transparency repaints)
    "xfwm4.xml": ch("xfwm4", `  <property name="general" type="empty">\n    <property name="use_compositing" type="bool" value="false"/>\n    <property name="theme" type="string" value="Default"/>\n  </property>`),
    "xfce4-screensaver.xml": ch("xfce4-screensaver", `  <property name="saver" type="empty">\n    <property name="enabled" type="bool" value="false"/>\n  </property>\n  <property name="lock" type="empty">\n    <property name="enabled" type="bool" value="false"/>\n  </property>`),
    "xfce4-power-manager.xml": ch("xfce4-power-manager", `  <property name="xfce4-power-manager" type="empty">\n    <property name="dpms-enabled" type="bool" value="false"/>\n    <property name="blank-on-ac" type="int" value="0"/>\n    <property name="lock-screen-suspend-hibernate" type="bool" value="false"/>\n  </property>`),
    "xfce4-session.xml": ch("xfce4-session", `  <property name="general" type="empty">\n    <property name="SaveOnExit" type="bool" value="false"/>\n    <property name="LockCommand" type="string" value=""/>\n  </property>\n  <property name="shutdown" type="empty">\n    <property name="LockScreen" type="bool" value="false"/>\n  </property>`),
    "keyboard-layout.xml": ch("keyboard-layout", `  <property name="Default" type="empty">\n    <property name="XkbDisable" type="bool" value="false"/>\n    <property name="XkbLayout" type="string" value="${keyboard}"/>\n    <property name="XkbVariant" type="string" value=""/>\n  </property>`),
  };
}

/** Autostart entries hidden for the session: screensavers, screen lockers, the power manager. */
export const DESKTOP_DISABLED_AUTOSTART = ["xfce4-screensaver", "light-locker", "xscreensaver", "xfce4-power-manager", "xfce-polkit", "polkit-gnome-authentication-agent-1"];

/**
 * The display (Xvfb), started when it is not up, and its desktop session: XFCE
 * (`dbus-launch --exit-with-session startxfce4`) when installed, else openbox. Idempotent and fast
 * when it runs: the session is started again only when it died (its pid is recorded); an openbox
 * left by an older Polpo is replaced by XFCE once XFCE is there. The session gets the agent's
 * language (LANG, generated with locale-gen when missing, else C.UTF-8), timezone (TZ) and
 * keyboard layout (setxkbmap); no screensaver, no locking, no power manager, no compositing.
 * A running display keeps its size (the new one applies when the machine restarts).
 */
export function desktopDisplayCommand(o: DesktopOptions = {}): string {
  const s = desktopSession(o);
  const X = DESKTOP_DISPLAY;
  const xfconf = Object.entries(xfconfFiles(s.keyboard))
    .map(([file, body]) => `[ -f "$XC/${file}" ] || printf '%s\\n' ${q(body)} >"$XC/${file}"; `).join("");
  const locale = s.lang.replace(/\.UTF-8$/, "");
  return COMMON
    + `if ! { [ -S ${X_SOCKET} ] && { alive "$D/xvfb.pid" || pgrep -x Xvfb >/dev/null 2>&1; }; }; then `
    + `command -v Xvfb >/dev/null 2>&1 || { echo "Xvfb is not installed" >&2; exit 2; }; `
    + `rm -f ${X_SOCKET} /tmp/.X${X.slice(1)}-lock; `
    + `$S nohup Xvfb ${X} -screen 0 ${s.screen} -nolisten tcp -ac >"$D/xvfb.log" 2>&1 </dev/null & echo $! >"$D/xvfb.pid"; echo ${q(`${s.size[0]}x${s.size[1]}`)} >"$D/size"; `
    + `i=0; while [ $i -lt 50 ] && [ ! -S ${X_SOCKET} ]; do sleep 0.1; i=$((i+1)); done; `
    + `[ -S ${X_SOCKET} ] || { echo "the virtual display did not start: $(tail -c 300 "$D/xvfb.log" 2>/dev/null)" >&2; exit 1; }; fi; `
    + `if command -v startxfce4 >/dev/null 2>&1 && command -v dbus-launch >/dev/null 2>&1; then `
    + `if ! alive "$D/wm.pid" || [ "$(cat "$D/wm.kind" 2>/dev/null)" != xfce ]; then `
    // an openbox from before XFCE was installed: XFCE's window manager takes over
    + `alive "$D/wm.pid" && kill "$(cat "$D/wm.pid")" 2>/dev/null; `
    + `XC="$HOME/.config/xfce4/xfconf/xfce-perchannel-xml"; mkdir -p "$XC" "$HOME/.config/autostart" "$HOME/Desktop"; `
    // the default panel, so XFCE does not ask which one on the first start
    + `[ -f "$XC/xfce4-panel.xml" ] || { [ -f /etc/xdg/xfce4/panel/default.xml ] && cp /etc/xdg/xfce4/panel/default.xml "$XC/xfce4-panel.xml"; }; `
    + xfconf
    + `for a in ${DESKTOP_DISABLED_AUTOSTART.join(" ")}; do printf '[Desktop Entry]\\nType=Application\\nName=%s\\nHidden=true\\n' "$a" >"$HOME/.config/autostart/$a.desktop"; done; `
    // the language: generated when missing (root, or sudo), else C.UTF-8
    + `SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"; LC=${q(s.lang)}; `
    + `haveloc() { locale -a 2>/dev/null | grep -qix ${q(`${locale}.utf-\\?8`)}; }; `
    + `if ! haveloc && [ -f /etc/locale.gen ] && command -v locale-gen >/dev/null 2>&1; then `
    + `$SUDO sh -c "grep -q '^${locale}.UTF-8 UTF-8' /etc/locale.gen || echo '${locale}.UTF-8 UTF-8' >>/etc/locale.gen; locale-gen" >"$D/locale.log" 2>&1; fi; `
    + `haveloc || LC=C.UTF-8; `
    + `DISPLAY=${X} LANG="$LC" LANGUAGE=${q(locale)} TZ=${q(s.timezone)} XDG_CURRENT_DESKTOP=XFCE $S nohup dbus-launch --exit-with-session startxfce4 >"$D/wm.log" 2>&1 </dev/null & echo $! >"$D/wm.pid"; echo xfce >"$D/wm.kind"; `
    + `fi; `
    + `elif command -v openbox >/dev/null 2>&1 && ! alive "$D/wm.pid"; then DISPLAY=${X} $S nohup openbox >"$D/wm.log" 2>&1 </dev/null & echo $! >"$D/wm.pid"; echo openbox >"$D/wm.kind"; fi; `
    // the keyboard layout and no blanking: cheap, every time (a session restart resets them)
    + `command -v setxkbmap >/dev/null 2>&1 && setxkbmap -display ${X} ${q(s.keyboard)} >/dev/null 2>&1; `
    + `command -v xset >/dev/null 2>&1 && xset -display ${X} s off -dpms s noblank >/dev/null 2>&1; true`;
}

/** The display with the default options (1280x800, it-IT, Europe/Rome). */
export const DESKTOP_DISPLAY_COMMAND = desktopDisplayCommand();

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

/** What runs: one `key=0|1` line each, then the session (`session=xfce|openbox`) and the screen (`size=WxH`). */
export const DESKTOP_INSPECT_COMMAND = COMMON
  + `if [ -S ${X_SOCKET} ] && { alive "$D/xvfb.pid" || pgrep -x Xvfb >/dev/null 2>&1; }; then echo display=1; else echo display=0; fi; `
  + `if alive "$D/wm.pid"; then echo wm=1; echo "session=$(cat "$D/wm.kind" 2>/dev/null)"; else echo wm=0; fi; `
  + `if alive "$D/vnc.pid"; then echo vnc=1; else echo vnc=0; fi; `
  + `if alive "$D/ws.pid"; then echo ws=1; else echo ws=0; fi; `
  + `if command -v x11vnc >/dev/null 2>&1 && command -v websockify >/dev/null 2>&1; then echo installed=1; else echo installed=0; fi; `
  + `[ -f "$D/size" ] && echo "size=$(cat "$D/size")"; true`;

/** Stop the live view (VNC and websockify); the display stays (a headed browser lives on it). */
export const DESKTOP_STOP_COMMAND = COMMON
  + `for p in ws vnc; do alive "$D/$p.pid" && kill "$(cat "$D/$p.pid")" 2>/dev/null; rm -f "$D/$p.pid"; done; rm -f "$D/vnc.pass"; true`;

export interface DesktopProcesses {
  display: boolean; wm: boolean; vnc: boolean; ws: boolean; installed: boolean;
  /** The desktop session running: XFCE, or openbox (XFCE could not be installed). */
  session?: "xfce" | "openbox";
  /** The running display's size ("1280x800"). */
  size?: string;
}

export function parseDesktopInspect(stdout: string): DesktopProcesses {
  const v = (k: string) => new RegExp(`^${k}=1$`, "m").test(stdout);
  const session = /^session=(xfce|openbox)$/m.exec(stdout)?.[1] as DesktopProcesses["session"];
  const size = /^size=(\d{3,4}x\d{3,4})$/m.exec(stdout)?.[1];
  return { display: v("display"), wm: v("wm"), vnc: v("vnc"), ws: v("ws"), installed: v("installed"), ...(session ? { session } : {}), ...(size ? { size } : {}) };
}

/** A command runner on the VM (a RemoteDriver, or the agent's workspace shell). */
export interface DesktopHost {
  exec(command: string, o?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Starting the display and its session (a locale may be generated the first time). */
const DISPLAY_TIMEOUT_MS = 60_000;

/**
 * Everything the display needs is installed: Xvfb and its tools, and XFCE with its package-only
 * companions; or openbox where XFCE could not be installed (the install log says so), so a VM
 * without XFCE does not try the long install again on every run.
 */
const DISPLAY_INSTALLED_CHECK =
  `{ ${Object.keys(DESKTOP_DISPLAY_PACKAGES).map((bin) => `command -v ${bin} >/dev/null 2>&1`).join(" && ")}; } && `
  + `{ { ok=0; ${Object.keys(DESKTOP_XFCE_PACKAGES).map((bin) => `command -v ${bin} >/dev/null 2>&1`).join(" && ")} && ok=1; `
  + `for p in ${DESKTOP_XFCE_EXTRA_PACKAGES.join(" ")}; do dpkg-query -W -f='\${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || ok=0; done; [ "$ok" = 1 ]; } `
  + `|| { command -v openbox >/dev/null 2>&1 && grep -q 'XFCE could not be installed' ${DESKTOP_DIR}/install.log 2>/dev/null; }; }`;

/**
 * The fast path, one command on the runner image: exit 3 when something is missing (the slow path
 * installs it), otherwise the display and its session started when they are not up
 * (desktopDisplayCommand), then a check that the XFCE session runs where XFCE is installed.
 */
export function desktopDisplayQuickCommand(o: DesktopOptions = {}): string {
  return `( ${DISPLAY_INSTALLED_CHECK} ) || exit 3; (${desktopDisplayCommand(o)}) || exit $?; `
    + `if command -v startxfce4 >/dev/null 2>&1 && command -v dbus-launch >/dev/null 2>&1; then `
    + `D=${DESKTOP_DIR}; [ "$(cat "$D/wm.kind" 2>/dev/null)" = xfce ] && [ -f "$D/wm.pid" ] && kill -0 "$(cat "$D/wm.pid" 2>/dev/null)" 2>/dev/null `
    + `|| { echo "the XFCE session did not start: $(tail -c 300 "$D/wm.log" 2>/dev/null)" >&2; exit 1; }; fi; true`;
}

/** The fast path with the default options (1280x800, it-IT, Europe/Rome). */
export const DESKTOP_DISPLAY_QUICK_COMMAND = desktopDisplayQuickCommand();

/**
 * The display up in the VM (installing Xvfb and XFCE when missing): undefined, else why not. The
 * installed case is one short command; the long install timeout applies only when something is
 * missing (a quick check that does not answer in time is an error, never a 10-minute wait).
 */
export async function ensureDesktopDisplay(host: DesktopHost, o: DesktopOptions = {}): Promise<string | undefined> {
  const quick = await host.exec(desktopDisplayQuickCommand(o), { timeoutMs: DISPLAY_TIMEOUT_MS }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String((err as Error)?.message ?? err) }));
  if (quick.exitCode === 0) return undefined;
  if (quick.exitCode !== 3) return `The virtual display did not start: ${(quick.stderr || quick.stdout).trim().slice(0, 400) || `exit ${quick.exitCode}`}`;
  const installed = await host.exec(desktopInstallCommand("display"), { timeoutMs: INSTALL_TIMEOUT_MS }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String((err as Error)?.message ?? err) }));
  if (installed.exitCode !== 0) return `The virtual display cannot be installed: ${(installed.stderr || installed.stdout).trim().slice(0, 400)}`;
  const up = await host.exec(desktopDisplayCommand(o), { timeoutMs: DISPLAY_TIMEOUT_MS }).catch((err) => ({ exitCode: 1, stdout: "", stderr: String((err as Error)?.message ?? err) }));
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
  /** Its screen: the running display's, else the computer's setting (desktop.size, default 1280x800). */
  size: string;
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
  /** The agents (their identity sets the desktop's language and timezone: the computer's default agent's). */
  agents?: () => DesktopAgent[] | Promise<DesktopAgent[]>;
}

/** An agent as the desktop needs it. */
export interface DesktopAgent { name: string; computers?: string[]; defaultComputer?: string; identity?: { locale?: string; timezone?: string } }

/** The desktop options of a computer: its size, and the language and timezone of the agent it is the default of (else the first using it). */
export function computerDesktopOptions(computer: ComputerConfig, agents: readonly DesktopAgent[] = []): DesktopOptions {
  const users = computerUsers(computer.id, agents as DesktopAgent[]);
  const user = users.find((u) => u.isDefault) ?? users[0];
  const identity = user ? agents.find((a) => a.name === user.name)?.identity : undefined;
  return {
    size: computerDesktopSize(computer),
    ...(identity?.locale ? { locale: identity.locale } : {}), ...(identity?.timezone ? { timezone: identity.timezone } : {}),
  };
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
    const base = { computerId: computer.id, display: DESKTOP_DISPLAY, size: computerDesktopSize(computer) };
    const unsupported = desktopUnsupported(computer);
    if (unsupported) return { ...base, state: "unsupported", note: unsupported };
    try {
      const r = await this.deps.manager().whenRunning(computer, async (d) => ({ out: await d.exec(DESKTOP_INSPECT_COMMAND, { timeoutMs: 20_000 }), remoteId: d.remoteId }));
      if (!r) return { ...base, state: "machine-off", note: "Its machine is not running: starting the live view starts it" };
      const processes = parseDesktopInspect(r.out.stdout);
      if (processes.display && processes.size) base.size = processes.size;
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
    const agents = await Promise.resolve(this.deps.agents?.()).catch(() => undefined) ?? [];
    const display = await host.exec(desktopDisplayCommand(computerDesktopOptions(computer, agents)), { timeoutMs: DISPLAY_TIMEOUT_MS });
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
    return { computerId: computer.id, display: DESKTOP_DISPLAY, size: computerDesktopSize(computer), state: "running", startedAt: s.startedAt };
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
