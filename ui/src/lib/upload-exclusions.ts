export const UPLOAD_EXCLUDED_DIRECTORIES = [
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
] as const;

export const UPLOAD_EXCLUDED_FILES = [
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
] as const;

const excludedDirectories = new Set<string>(UPLOAD_EXCLUDED_DIRECTORIES);
const excludedFiles = new Set<string>(UPLOAD_EXCLUDED_FILES);

export interface UploadExclusions {
  files: number;
  directories: string[];
  reasons: string[];
}

export interface UploadPathExclusion {
  kind: "directory" | "file";
  reason: string;
  path: string;
}

export function uploadPathExclusion(
  path: string,
  entryKind: "directory" | "file" = "file",
): UploadPathExclusion | undefined {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];
    if (excludedDirectories.has(segment)) {
      return { kind: "directory", reason: segment, path: segments.slice(0, index + 1).join("/") };
    }
  }

  const leaf = segments.at(-1);
  if (entryKind === "directory" && leaf && excludedDirectories.has(leaf)) {
    return { kind: "directory", reason: leaf, path: segments.join("/") };
  }
  if (leaf && excludedFiles.has(leaf)) {
    return { kind: "file", reason: leaf, path: segments.join("/") };
  }
  return undefined;
}

export function emptyUploadExclusions(): UploadExclusions {
  return { files: 0, directories: [], reasons: [] };
}

export function mergeUploadExclusions(...summaries: UploadExclusions[]): UploadExclusions {
  return {
    files: summaries.reduce((total, summary) => total + summary.files, 0),
    directories: [...new Set(summaries.flatMap((summary) => summary.directories))],
    reasons: [...new Set(summaries.flatMap((summary) => summary.reasons))],
  };
}

export function describeUploadExclusions(exclusions: UploadExclusions): string | undefined {
  const parts: string[] = [];
  if (exclusions.directories.length > 0) {
    parts.push(`${exclusions.directories.length} generated folder${exclusions.directories.length === 1 ? "" : "s"}`);
  }
  if (exclusions.files > 0) {
    parts.push(`${exclusions.files} file${exclusions.files === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return undefined;

  const reasons = exclusions.reasons.slice(0, 4).join(", ");
  const more = exclusions.reasons.length > 4 ? ` +${exclusions.reasons.length - 4} more` : "";
  return `Excluded ${parts.join(" and ")}${reasons ? ` (${reasons}${more})` : ""}`;
}
