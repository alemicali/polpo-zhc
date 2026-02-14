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

export function Shell() {
  const pageId = useStore((s) => s.page.id);
  const polpo = usePolpo();
  const store = useStore.getState();

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
      // TODO: send to LLM chat
      s.log("Chat mode — coming soon", [seg("Chat mode — coming soon", "gray")]);
    } else if (mode === "plan") {
      // TODO: create plan from description
      s.log("Plan mode — coming soon", [seg("Plan mode — coming soon", "gray")]);
    } else {
      // Task mode — create task from description
      // TODO: LLM task preparation or direct task creation
      s.log("Task creation — coming soon", [seg("Task creation — coming soon", "gray")]);
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
    default:
      return <MainView onSubmit={handleSubmit} />;
  }
}
