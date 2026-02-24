import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Ensure the project directory has been initialized with `polpo init`.
 * If `.polpo/polpo.json` doesn't exist, print a hint and exit.
 */
export async function ensureSetup(dir: string): Promise<void> {
  const configPath = join(dir, ".polpo", "polpo.json");
  if (!existsSync(configPath)) {
    console.error(
      `No Polpo project found in ${dir}.\nRun \`polpo init\` to create one, or \`polpo setup\` for guided configuration.`,
    );
    process.exit(1);
  }
}
