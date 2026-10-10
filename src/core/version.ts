import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Defined at compile time by the desktop sidecar build (bun --define), which has no package.json on disk. */
declare const POLPO_VERSION: string | undefined;

function packageVersion(): string {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
  try {
    return existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf-8")).version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** The Polpo version: from package.json next to dist/ (npm, source checkout) or from the sidecar build. */
export const POLPO_PACKAGE_VERSION: string = typeof POLPO_VERSION === "string" ? POLPO_VERSION : packageVersion();
