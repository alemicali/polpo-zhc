import { Editor, Key, matchesKey } from "@mariozechner/pi-tui";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";

export class CustomEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlA?: () => void; // Toggle approval mode
  onCtrlO?: () => void; // Toggle task panel
  onCtrlR?: () => void; // Voice recording
  onCtrlL?: () => void; // Clear stream
  onTab?: () => void; // Cycle input mode

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("a")) && this.onCtrlA) {
      this.onCtrlA();
      return;
    }
    if (matchesKey(data, Key.ctrl("o")) && this.onCtrlO) {
      this.onCtrlO();
      return;
    }
    if (matchesKey(data, Key.ctrl("r")) && this.onCtrlR) {
      this.onCtrlR();
      return;
    }
    if (matchesKey(data, Key.ctrl("l")) && this.onCtrlL) {
      this.onCtrlL();
      return;
    }
    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }
    // Tab handling: only cycle mode if NOT in autocomplete context
    if (matchesKey(data, Key.tab) && this.onTab && !this.isShowingAutocomplete()) {
      // Check if buffer starts with "/" - if so let Editor handle tab completion
      const text = this.getText().trim();
      if (!text.startsWith("/")) {
        this.onTab();
        return;
      }
    }
    super.handleInput(data);
  }
}
