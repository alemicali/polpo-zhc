/**
 * /config — view and edit settings.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export function cmdConfig({ polpo, store }: CommandAPI) {
  const config = polpo.getConfig();
  if (!config) {
    store.log("No configuration loaded");
    return;
  }

  store.log("Configuration:", [seg("Configuration:", undefined, true)]);
  store.log(`  Project: ${config.project}`, [
    seg("  Project: ", "gray"),
    seg(config.project),
  ]);
  store.log(`  Max retries: ${config.settings.maxRetries}`, [
    seg("  Max retries: ", "gray"),
    seg(`${config.settings.maxRetries}`),
  ]);
  store.log(`  Log level: ${config.settings.logLevel}`, [
    seg("  Log level: ", "gray"),
    seg(config.settings.logLevel),
  ]);

  // TODO: implement settings editor via pages
}
