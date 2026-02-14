/**
 * Shell — page router. Renders the current page based on store state.
 * Main page shows Stream + TaskPanel + Input.
 * Other pages replace the entire screen (no overlay glitches).
 */

import { useStore } from "../store.js";
import { usePolpo } from "../app.js";
import { dispatch } from "../commands/router.js";
import { seg } from "../format.js";
import { MainView } from "./MainView.js";
import { PickerPage } from "../pages/PickerPage.js";
import { EditorPage } from "../pages/EditorPage.js";
import { ViewerPage } from "../pages/ViewerPage.js";
import { ConfirmPage } from "../pages/ConfirmPage.js";
import { createTask } from "../actions/create-task.js";
import { createPlan } from "../actions/create-plan.js";
import { startChat } from "../actions/chat.js";

export function Shell() {
  const pageId = useStore((s) => s.page.id);
  const polpo = usePolpo();

  const handleSubmit = (text: string) => {
    const s = useStore.getState();
    s.pushHistory(text);

    // Echo user input
    s.pushLine({ type: "user", text, ts: new Date().toISOString() });

    // Slash command?
    if (text.startsWith("/")) {
      const handled = dispatch(text, { polpo, store: s, args: [] });
      if (!handled) {
        s.log(`Unknown command: ${text}`, [seg(`Unknown command: ${text}`, "red")]);
      }
      return;
    }

    // Mode-specific handling
    const mode = s.inputMode;
    if (mode === "chat") {
      startChat(text, polpo, s);
    } else if (mode === "plan") {
      createPlan(text, polpo, s);
    } else {
      createTask(text, polpo, s);
    }
  };

  switch (pageId) {
    case "main":
      return <MainView onSubmit={handleSubmit} />;
    case "picker":
      return <PickerPage />;
    case "editor":
      return <EditorPage />;
    case "viewer":
      return <ViewerPage />;
    case "confirm":
      return <ConfirmPage />;
    default:
      return <MainView onSubmit={handleSubmit} />;
  }
}
