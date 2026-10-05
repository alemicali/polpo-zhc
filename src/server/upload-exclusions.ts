const EXCLUDED_UPLOAD_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vite",
  ".pnpm-store",
  ".yarn",
  "dist",
  "build",
  "out",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".tox",
]);

const EXCLUDED_UPLOAD_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export function uploadExclusionReason(path: string): string | undefined {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const excludedDirectory = segments.find((segment) => EXCLUDED_UPLOAD_DIRECTORIES.has(segment));
  if (excludedDirectory) return excludedDirectory;
  const leaf = segments.at(-1);
  return leaf && EXCLUDED_UPLOAD_FILES.has(leaf) ? leaf : undefined;
}
