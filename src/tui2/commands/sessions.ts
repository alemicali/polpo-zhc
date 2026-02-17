import type { CommandAPI } from "../types.js";
import { theme } from "../theme.js";
import { PickerOverlay } from "../overlays/picker.js";
import { ViewerOverlay } from "../overlays/viewer.js";
import { ConfirmOverlay } from "../overlays/confirm.js";

export function cmdSessions(api: CommandAPI): void {
  const { polpo, tui } = api;

  const sessionStore = polpo.getSessionStore();
  if (!sessionStore) {
    tui.logSystem("No session store available");
    tui.requestRender();
    return;
  }

  const sessions = sessionStore.listSessions();
  if (sessions.length === 0) {
    tui.logSystem("No sessions");
    tui.requestRender();
    return;
  }

  const items = sessions.map((s) => ({
    value: s.id,
    label: s.title ?? s.id,
    description: `${s.messageCount} messages · ${new Date(s.updatedAt).toLocaleDateString()}`,
  }));

  const picker = new PickerOverlay({
    title: "Sessions",
    hint: "Enter: view · d: delete · Esc: close",
    items,
    onSelect: (item) => {
      tui.hideOverlay();
      showSession(api, sessionStore, item.value, item.label);
    },
    onCancel: () => tui.hideOverlay(),
    onKey: (key: string, item) => {
      if (key === "d" && item) {
        tui.hideOverlay();
        const confirm = new ConfirmOverlay({
          message: `Delete session "${item.label}"?`,
          onConfirm: () => {
            tui.hideOverlay();
            sessionStore.deleteSession(item.value);
            tui.logSystem(`Deleted session: ${item.label}`);
            tui.requestRender();
          },
          onCancel: () => {
            tui.hideOverlay();
            // Reopen the picker
            cmdSessions(api);
          },
        });
        tui.showOverlay(confirm);
        return true;
      }
      return false;
    },
  });
  tui.showOverlay(picker);
}

function showSession(
  api: CommandAPI,
  sessionStore: NonNullable<ReturnType<typeof api.polpo.getSessionStore>>,
  sessionId: string,
  title: string,
): void {
  const { tui } = api;
  const messages = sessionStore.getMessages(sessionId);
  if (messages.length === 0) {
    tui.logSystem("Session is empty");
    tui.requestRender();
    return;
  }

  const content = messages
    .map((m) => {
      const role = m.role === "user" ? theme.info("[user]") : theme.dim("[assistant]");
      return `${role} ${m.content}`;
    })
    .join("\n\n");

  const viewer = new ViewerOverlay({
    title: `Session: ${title}`,
    content,
    onClose: () => tui.hideOverlay(),
  });
  tui.showOverlay(viewer);
}
