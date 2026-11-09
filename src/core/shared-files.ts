/**
 * Files a turn may send out of the server (a Telegram attachment, a reply's file): only regular
 * files inside the given roots, never under a hidden folder (.polpo, .git…) or named like credentials.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Names that may hold credentials; never sent out of the server. */
const SENSITIVE_NAME = /(^|[._-])(env|secrets?|credentials?|tokens?)([._-]|$)|\.(pem|key|p12|pfx|kdbx)$|^id_(rsa|ed25519|ecdsa)/i;

/**
 * Resolve a path the agent asked to open, only if it is a regular file inside
 * one of `roots`, not under a hidden directory (.polpo, .git, …) and not named
 * like a credential file.
 */
export function resolveSharedFile(path: string, roots: string[]): string | undefined {
  const realRoots = roots.filter(r => existsSync(r)).map(r => realpathSync(r));
  const candidates = isAbsolute(path) ? [path] : roots.map(r => resolve(join(r, path)));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    const root = realRoots.find(r => real.startsWith(r + sep));
    if (!root || !statSync(real).isFile()) continue;
    const segments = relative(root, real).split(sep);
    if (segments.some(s => s.startsWith("."))) continue;
    if (SENSITIVE_NAME.test(basename(real))) continue;
    return real;
  }
  return undefined;
}
