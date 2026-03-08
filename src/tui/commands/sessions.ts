/**
 * /sessions — view agent session transcripts.
 */

import type { CommandAPI } from "./types.js";
import { seg } from "../format.js";

export async function cmdSessions({ polpo, store }: CommandAPI) {
  const sessionStore = polpo.getSessionStore();
  if (!sessionStore) {
    store.log("Session store not available", [seg("Session store not available", "gray")]);
    return;
  }

  const sessions = await sessionStore.listSessions();
  if (sessions.length === 0) {
    store.log("No sessions", [seg("No sessions", "gray")]);
    return;
  }

  store.navigate({
    id: "picker",
    title: `Sessions (${sessions.length})`,
    items: sessions.map((s) => ({
      label: s.title ?? s.id,
      value: s.id,
      description: `${s.messageCount} messages — ${s.updatedAt.slice(0, 16)}`,
    })),
    hint: "Enter to view  d to delete  Esc back",
    onSelect: async (_idx, sessionId) => {
      const session = await sessionStore.getSession(sessionId);
      if (!session) return;

      const messages = await sessionStore.getMessages(sessionId);
      const content = messages
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n\n");

      store.navigate({
        id: "viewer",
        title: session.title ?? session.id,
        content: content || "(empty session)",
        onClose: () => store.goMain(),
      });
    },
    onCancel: () => store.goMain(),
    onKey: (input, _idx, sessionId) => {
      if (input === "d") {
        store.navigate({
          id: "confirm",
          message: `Delete session "${sessionId}"?`,
          onConfirm: async () => {
            await sessionStore.deleteSession(sessionId);
            store.goMain();
            store.log(`Deleted session: ${sessionId}`, [
              seg("- ", "red"),
              seg(sessionId, undefined, true),
            ]);
          },
          onCancel: () => cmdSessions({ polpo, store, args: [] }),
        });
      }
    },
  });
}
