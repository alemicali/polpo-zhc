/**
 * Rooms: group conversations of people and agents, whatever the channel.
 *
 * A room is the conversation a group has: a Telegram group (or one of its topics), a group
 * chat on the web. It holds one transcript for everyone (people and agents, each message with
 * its author) and how the room answers: who replies to what, and whether agents talk to each
 * other. The agents still run their turns in sessions of their own; what they read is the room.
 */

/** Where the room lives. */
export type RoomKind = "web" | "telegram";

/** Which messages get an answer: only those addressed to an agent, or also by intent. */
export type RoomReplyMode = "mentions" | "intent";

export interface RoomSettings {
  /** "mentions": mentions, replies and commands only. "intent": also what a classifier judges is for an agent. */
  replyMode?: RoomReplyMode;
  /** "intent": how sure the classifier must be (0–1). Default 0.7. */
  intentThreshold?: number;
  /** Several agents answering one message: all at once (default, like people), or one after the other. */
  replyOrder?: "parallel" | "sequential";
  /** Agents may answer each other's messages. */
  agentToAgent?: boolean;
  /** Agent turns set off by one person's message, at most (agentToAgent). Default 3. */
  maxAgentHops?: number;
}

export interface Room {
  /** Stable id: "web:<nanoid>" or the channel conversation ("telegram:group:<chat>[:topic:<n>]"). */
  id: string;
  kind: RoomKind;
  title: string;
  /** The agents in the room (web rooms; a Telegram group's agents are its bots). */
  agents: string[];
  settings: RoomSettings;
  createdAt: string;
  updatedAt: string;
}

export type RoomAuthorKind = "person" | "agent";

export interface RoomMessage {
  id: string;
  roomId: string;
  ts: string;
  authorKind: RoomAuthorKind;
  /** Person: their peer or user id; agent: its name ("polpo" for the orchestrator). */
  authorId: string;
  authorName: string;
  text: string;
  /** The channel's id of the message (Telegram message_id): a message is stored once. */
  externalId?: string;
  /** The agents the message was addressed to (mentions, replies, commands). */
  addressedTo?: string[];
  /** An agent's reply: the message it answers. */
  replyToId?: string;
}

export type NewRoomMessage = Omit<RoomMessage, "id" | "ts" | "roomId"> & { ts?: string };

export interface RoomStore {
  getRoom(id: string): Promise<Room | undefined>;
  listRooms(kind?: RoomKind): Promise<Room[]>;
  /** Create the room, or return it as it is when it exists. */
  ensureRoom(room: Pick<Room, "id" | "kind" | "title"> & Partial<Pick<Room, "agents" | "settings">>): Promise<Room>;
  updateRoom(id: string, patch: Partial<Pick<Room, "title" | "agents" | "settings">>): Promise<Room | undefined>;
  deleteRoom(id: string): Promise<boolean>;
  /** Append a message; with an externalId already stored, returns the stored one unchanged. */
  addMessage(roomId: string, message: NewRoomMessage): Promise<RoomMessage>;
  /** The last messages, oldest first. */
  getRecentMessages(roomId: string, limit: number): Promise<RoomMessage[]>;
  /** Messages after `messageId` (exclusive), oldest first; all of them when it is not in the room. */
  getMessagesAfter(roomId: string, messageId: string | undefined, limit: number): Promise<RoomMessage[]>;
}
