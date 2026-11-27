/**
 * The browser agents use is real Google Chrome, never Chromium: not agent-browser's bundled
 * Chrome for Testing, not Playwright's Chromium. Sites like Google Maps, Instagram and Facebook
 * flag Chromium (and headless browsers) as bots; Google Chrome is what people use.
 *
 *   - this server: the Chrome installed here (google-chrome-stable / google-chrome, the macOS app),
 *     found once and cached; POLPO_AGENT_BROWSER_EXECUTABLE overrides it. No Chrome: the browser
 *     tools fail with a clear error (no fallback to Chromium);
 *   - a remote computer (Daytona VM, Debian amd64): /usr/bin/google-chrome, installed once from
 *     Google's .deb when it is missing (the runner image polpo-runner-vm-4 ships it).
 *
 * On this server agent-browser gets it as `--executable-path`. On a remote computer Polpo launches
 * it itself (agentChromeEnsureScript below: no automation flags) and agent-browser attaches over CDP.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/** Environment variable: the Chrome executable agents' browsers use on this server. */
export const AGENT_BROWSER_EXECUTABLE_ENV = "POLPO_AGENT_BROWSER_EXECUTABLE";

/** Google Chrome in a remote computer (Debian package google-chrome-stable). */
export const SANDBOX_CHROME_PATH = "/usr/bin/google-chrome";
/** Google's Debian package (amd64 only: Chrome has no Linux arm64 build). */
export const SANDBOX_CHROME_DEB_URL = "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb";

const LINUX_CHROME_NAMES = ["google-chrome-stable", "google-chrome"];
const LINUX_CHROME_PATHS = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"];
const MAC_CHROME_APP = "Google Chrome.app/Contents/MacOS/Google Chrome";
const WINDOWS_CHROME = "Google\\Chrome\\Application\\chrome.exe";

function executable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where Google Chrome usually is on this platform, in order (PATH lookups first on Linux). */
export function hostChromeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === "darwin") return [join("/Applications", MAC_CHROME_APP), join(homedir(), "Applications", MAC_CHROME_APP)];
  if (platform === "win32") {
    return [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((d): d is string => !!d).map((d) => join(d, WINDOWS_CHROME));
  }
  const fromPath = (env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((dir) => LINUX_CHROME_NAMES.map((n) => join(dir, n)));
  return [...new Set([...fromPath, ...LINUX_CHROME_PATHS])];
}

let cachedChrome: string | undefined;

/** Forget the cached Chrome (tests, or after installing it). */
export function resetHostChromeCache(): void {
  cachedChrome = undefined;
}

/** The message when this server has no Google Chrome. */
export function chromeMissingError(override?: string): string {
  if (override) {
    return `${AGENT_BROWSER_EXECUTABLE_ENV} is set to "${override}", which is not an executable file. `
      + "Point it to Google Chrome (e.g. /usr/bin/google-chrome) or unset it.";
  }
  return "Google Chrome is not installed on this server. Agents' browsers run in real Google Chrome, never Chromium "
    + "(Chromium and headless browsers get flagged as bots by sites like Google Maps, Instagram and Facebook). "
    + "Install Google Chrome (https://www.google.com/chrome/; on Debian/Ubuntu: "
    + `curl -fsSLO ${SANDBOX_CHROME_DEB_URL} && sudo apt-get install -y ./google-chrome-stable_current_amd64.deb) `
    + `or set ${AGENT_BROWSER_EXECUTABLE_ENV} to its path.`;
}

/**
 * Google Chrome on this server: `{ path }`, or `{ error }` saying it must be installed. Found once
 * and cached (a missing Chrome is looked for again next time, so installing it needs no restart).
 */
export function hostChromeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  candidates: () => string[] = () => hostChromeCandidates(process.platform, env),
): { ok: true; path: string } | { ok: false; error: string } {
  const override = env[AGENT_BROWSER_EXECUTABLE_ENV]?.trim();
  if (override) {
    return isAbsolute(override) && existsSync(override) && executable(override) ? { ok: true, path: override } : { ok: false, error: chromeMissingError(override) };
  }
  if (cachedChrome && existsSync(cachedChrome)) return { ok: true, path: cachedChrome };
  cachedChrome = candidates().find((p) => existsSync(p) && executable(p));
  return cachedChrome ? { ok: true, path: cachedChrome } : { ok: false, error: chromeMissingError() };
}

/** agent-browser's flags for Chrome on this server (an error when it is not installed). */
export function hostChromeArgs(
  env: NodeJS.ProcessEnv = process.env,
  candidates?: () => string[],
): { ok: true; path: string; args: string[] } | { ok: false; error: string } {
  const chrome = hostChromeExecutable(env, candidates);
  return chrome.ok ? { ...chrome, args: ["--executable-path", chrome.path] } : chrome;
}

/**
 * Install Google Chrome in a remote computer when it is missing: one `command -v` when it is there
 * (idempotent, a no-op on the runner image); otherwise Google's .deb with apt-get (which pulls its
 * libraries), as root or with sudo. amd64 only. Run in its own shell (it exits).
 */
export const SANDBOX_CHROME_INSTALL_COMMAND =
  `command -v google-chrome >/dev/null 2>&1 && exit 0; `
  + `case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in amd64|x86_64) ;; `
  + `*) echo "Google Chrome has no Linux build for $(uname -m): agents' browsers need an amd64 computer" >&2; exit 1;; esac; `
  + `SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"; F=/tmp/polpo-google-chrome.deb; L=/tmp/polpo-google-chrome-install.log; `
  + `curl -fsSL -o "$F" ${SANDBOX_CHROME_DEB_URL} >"$L" 2>&1 `
  + `&& $SUDO sh -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $F" >>"$L" 2>&1; `
  + `rm -f "$F"; command -v google-chrome >/dev/null 2>&1 `
  + `|| { echo "could not install Google Chrome: $(tail -c 500 "$L" 2>/dev/null)" >&2; exit 1; }`;

// ─── The agent's own Chrome on a remote computer ───
//
// agent-browser launches Chrome through Playwright with automation flags (--enable-automation…):
// navigator.webdriver is true and Google sign-in answers "This browser or app may not be secure",
// even with real Google Chrome and a residential IP. So on a remote computer Polpo launches the
// agent's Chrome itself, like a person would (no automation flags), ONE per agent profile, with a
// DevTools port bound to 127.0.0.1, and agent-browser attaches to it with `--cdp <port>`.
// It survives task runs (a page a person left open during take control stays); it goes away with
// the computer (stop, hibernation) and is launched again on the next browser command.

/** Where the agents' Chrome processes are recorded in the VM (under $HOME): <profile>.pid/.port/.conf/.log. */
export const AGENT_CHROME_STATE_DIR = ".polpo/browser-chrome";
/** The agents' profiles in the VM (under $HOME): Chrome's --user-data-dir. */
export const AGENT_CHROME_PROFILES_DIR = ".polpo/browser-profiles";
/** The browser's language when the agent's identity sets none (identity.locale). */
export const AGENT_CHROME_DEFAULT_LOCALE = "it-IT";
/** The browser's timezone when the agent's identity sets none (identity.timezone). */
export const AGENT_CHROME_DEFAULT_TIMEZONE = "Europe/Rome";
/** DevTools ports: each profile starts from its own port in this range (the next free one is taken). */
export const AGENT_CHROME_PORT_BASE = 9300;
export const AGENT_CHROME_PORT_RANGE = 600;

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/;

/** The browser's language and timezone from the agent's identity (defaults: it-IT, Europe/Rome). */
export function agentChromeLocale(identity?: { locale?: string; timezone?: string }): { locale: string; acceptLanguage: string; timezone: string } {
  const locale = identity?.locale?.trim() && LOCALE_RE.test(identity.locale.trim()) ? identity.locale.trim() : AGENT_CHROME_DEFAULT_LOCALE;
  const timezone = identity?.timezone?.trim() && TIMEZONE_RE.test(identity.timezone.trim()) ? identity.timezone.trim() : AGENT_CHROME_DEFAULT_TIMEZONE;
  const lang = locale.split("-")[0]!;
  return { locale, acceptLanguage: lang === locale ? locale : `${locale},${lang}`, timezone };
}

/** The DevTools port a profile starts from (stable per profile name). */
export function agentChromeBasePort(profileName: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < profileName.length; i++) h = Math.imul(h ^ profileName.charCodeAt(i), 0x01000193) >>> 0;
  return AGENT_CHROME_PORT_BASE + (h % AGENT_CHROME_PORT_RANGE);
}

/** A profile name safe as a file name (what browser-tools derives from the profile dir). */
export function agentChromeProfileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "default";
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface AgentChromeLaunch {
  /** The profile (file-name safe): $HOME/.polpo/browser-profiles/<profileName>. */
  profileName: string;
  /** The agent-browser session that attaches to it (closed before a relaunch, so it re-attaches). */
  session: string;
  /** The egress proxy (the same URL agent-browser used to get): Chrome's --proxy-server. */
  proxy?: string;
  /** On this X display (the computer's desktop); undefined: headless. */
  display?: string;
  /** The window size (the desktop's): [width, height]. */
  windowSize: [number, number];
  locale: string;
  acceptLanguage: string;
  timezone: string;
  /** Google Chrome (default /usr/bin/google-chrome). */
  chromePath?: string;
}

/** Chrome's command-line flags for the agent's own Chrome (no automation flags, ever). */
export function agentChromeFlags(o: AgentChromeLaunch): string[] {
  return [
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check",
    `--lang=${o.locale}`, `--accept-lang=${o.acceptLanguage}`,
    `--window-size=${o.windowSize[0]},${o.windowSize[1]}`, "--window-position=0,0",
    ...(o.display ? [] : ["--headless=new"]),
    ...(o.proxy ? [`--proxy-server=${o.proxy}`, "--proxy-bypass-list=<-loopback>"] : []),
  ];
}

/** A DevTools endpoint answers on 127.0.0.1:$1 (node: in every runner image, agent-browser needs it). */
const CDP_ANSWERS = `cdp() { node -e "require('http').get('http://127.0.0.1:'+process.argv[1]+'/json/version',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" "$1" >/dev/null 2>&1; }; `;
const PORT_BUSY = `busy() { node -e "require('net').connect(+process.argv[1],'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" "$1" >/dev/null 2>&1; }; `;

/**
 * Shell script (run in the VM) that makes sure the agent's Chrome runs and prints its DevTools
 * port on stdout (errors on stderr, exit 1):
 *   - ours, alive, same settings (proxy, language, timezone, display) and answering: its port;
 *   - otherwise ours is stopped (by its pid), the agent-browser session is closed (off a dead
 *     Chrome; a Chrome agent-browser itself launched on the profile goes with it), any process
 *     still holding the profile's SingletonLock is stopped, and Chrome is launched: its own
 *     command, TZ in its environment, --no-sandbox only as root, pid/port/settings recorded.
 * The secret a browser_fill carries in the environment never reaches Chrome (unset first).
 */
export function agentChromeEnsureScript(o: AgentChromeLaunch): string {
  const flags = agentChromeFlags(o);
  const conf = JSON.stringify({ proxy: o.proxy ?? null, locale: o.locale, acceptLanguage: o.acceptLanguage, timezone: o.timezone, display: o.display ?? null, size: o.windowSize, chrome: o.chromePath ?? SANDBOX_CHROME_PATH });
  const lang = o.locale.replace("-", "_");
  return `unset POLPO_BROWSER_SECRET; `
    + `D="$HOME"/${AGENT_CHROME_STATE_DIR}; mkdir -p "$D" && chmod 700 "$D"; `
    + `N=${q(o.profileName)}; PROF="$HOME"/${AGENT_CHROME_PROFILES_DIR}/"$N"; mkdir -p "$PROF"; `
    + `PF="$D/$N.pid"; PO="$D/$N.port"; CF="$D/$N.conf"; LOG="$D/$N.log"; CONF=${q(conf)}; `
    + `alive() { [ -f "$PF" ] && kill -0 "$(cat "$PF" 2>/dev/null)" 2>/dev/null; }; `
    + CDP_ANSWERS + PORT_BUSY
    + `stop() { kill "$1" 2>/dev/null; i=0; while [ $i -lt 50 ] && kill -0 "$1" 2>/dev/null; do sleep 0.1; i=$((i+1)); done; kill -9 "$1" 2>/dev/null; true; }; `
    + `if alive && [ "$(cat "$CF" 2>/dev/null)" = "$CONF" ] && cdp "$(cat "$PO" 2>/dev/null)"; then cat "$PO"; exit 0; fi; `
    + `alive && stop "$(cat "$PF")"; rm -f "$PF"; `
    + `agent-browser --session ${q(o.session)} close >/dev/null 2>&1; `
    + `L=$(readlink "$PROF/SingletonLock" 2>/dev/null); LP=\${L##*-}; `
    + `if expr "$LP" : '[0-9][0-9]*$' >/dev/null && kill -0 "$LP" 2>/dev/null && tr '\\0' ' ' <"/proc/$LP/cmdline" 2>/dev/null | grep -q chrome; then stop "$LP"; fi; `
    + `rm -f "$PROF/SingletonLock" "$PROF/SingletonSocket" "$PROF/SingletonCookie"; `
    + `P=$(cat "$PO" 2>/dev/null); expr "$P" : '[0-9][0-9]*$' >/dev/null || P=${agentChromeBasePort(o.profileName)}; `
    + `i=0; while [ $i -lt 100 ] && busy "$P"; do P=$((P+1)); i=$((i+1)); done; `
    + `NS=""; [ "$(id -u)" = 0 ] && NS=--no-sandbox; S=$(command -v setsid 2>/dev/null || true); `
    + `TZ=${q(o.timezone)} LANGUAGE=${q(lang)}${o.display ? ` DISPLAY=${q(o.display)}` : ""} $S nohup ${q(o.chromePath ?? SANDBOX_CHROME_PATH)} `
    + `--user-data-dir="$PROF" --remote-debugging-port="$P" ${flags.map(q).join(" ")} $NS about:blank >"$LOG" 2>&1 </dev/null & echo $! >"$PF"; `
    + `echo "$P" >"$PO"; printf '%s' "$CONF" >"$CF"; `
    + `i=0; while [ $i -lt 150 ] && ! cdp "$P"; do alive || break; sleep 0.1; i=$((i+1)); done; `
    + `cdp "$P" || { echo "Google Chrome did not start for profile $N: $(tail -c 400 "$LOG" 2>/dev/null)" >&2; exit 1; }; `
    + `echo "$P"`;
}

/** Shell command (VM): the agent's Chrome DevTools port when it runs (empty otherwise; never launches it). */
export function agentChromePortCommand(profileName: string): string {
  return `F="$HOME"/${AGENT_CHROME_STATE_DIR}/${q(profileName)}; `
    + `if [ -f "$F.pid" ] && kill -0 "$(cat "$F.pid" 2>/dev/null)" 2>/dev/null; then cat "$F.port" 2>/dev/null; fi; true`;
}
