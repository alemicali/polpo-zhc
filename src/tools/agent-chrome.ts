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
 * agent-browser gets it as `--executable-path`.
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
 * agent-browser's flags for Chrome in a remote computer, as shell words: the executable, and
 * `--no-sandbox` when commands run as root (Chrome refuses to start as root with its sandbox on;
 * Daytona VMs run as root).
 */
export const SANDBOX_CHROME_FLAGS = `--executable-path ${SANDBOX_CHROME_PATH} $([ "$(id -u)" = 0 ] && echo '--args --no-sandbox')`;

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
