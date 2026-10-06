/**
 * A room's transcript as an agent reads it on its turn: what was said since it last spoke
 * (people and the other agents), then the message it answers.
 */

import type { RoomMessage } from "@polpo-ai/core";

/** A turn reads at most this many room lines since the agent last spoke. */
export const ROOM_TURN_LINES = 30;

const lineOf = (m: RoomMessage) => `${m.authorKind === "agent" ? `${m.authorName} (agent)` : m.authorName}: ${m.text.slice(0, 1_500)}`;

/**
 * The text of an agent's turn. `recent` is the room's last messages (oldest first), `me` the
 * agent's id, `current` the message being answered (left out of the lines, said last).
 */
export function roomTurnText(recent: RoomMessage[], me: string, current: { id?: string; speaker: string; text: string }): string {
  const speakerLine = `${current.speaker}: ${current.text}`;
  const mine = recent.map((m) => m.authorKind === "agent" && m.authorId === me).lastIndexOf(true);
  const since = recent.slice(mine + 1).filter((m) => m.id !== current.id).slice(-ROOM_TURN_LINES);
  if (since.length === 0) return speakerLine;
  const header = mine >= 0 ? "[In the group since your last reply]" : "[Earlier in the group]";
  return `${header}\n${since.map(lineOf).join("\n")}\n\n${speakerLine}`;
}
