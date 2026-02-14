/**
 * /sessions — view agent session transcripts.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export function cmdSessions({ store }: CommandAPI) {
  store.log("Sessions viewer — coming soon", [
    seg("Sessions viewer", undefined, true),
    seg(" — coming soon", "gray"),
  ]);

  // TODO: implement session browser via pages
}
