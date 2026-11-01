/**
 * Files inside a task's output folder (packages/core/src/output-paths.ts), listed for the tasks
 * that depend on it so their agents know what they can read.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_OUTPUT_SUBDIR } from "../tools/tool-output.js";

const MAX_DEPTH = 4;

/**
 * Files under `dir`, relative to it with "/" separators, sorted, at most `limit`.
 * Offloaded tool outputs (`tool-output/`) are not deliverables and are left out.
 * A folder that does not exist yet has no files.
 */
export async function listOutputFiles(dir: string, limit = 200): Promise<string[]> {
  const files: string[] = [];
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= limit) return;
      if (depth === 0 && entry.name === TOOL_OUTPUT_SUBDIR) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(join(abs, entry.name), path, depth + 1);
      } else {
        files.push(path);
      }
    }
  };
  await walk(dir, "", 0);
  return files;
}
