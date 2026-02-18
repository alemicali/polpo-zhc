import { Container, Editor, Text, type TUI } from "@mariozechner/pi-tui";
import { editorTheme, theme } from "../theme.js";

export interface EditorOverlayOptions {
  title: string;
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
  tui: TUI;
}

export class EditorOverlay extends Container {
  private editor: Editor;
  private onSave: (text: string) => void;
  private onCancel: () => void;

  constructor(options: EditorOverlayOptions) {
    super();
    this.onSave = options.onSave;
    this.onCancel = options.onCancel;

    const header = new Text(theme.header(` ${options.title}`), 0, 0);
    this.addChild(header);
    this.addChild(new Text(theme.dim(" Ctrl+S save · Esc cancel"), 0, 0));
    this.addChild(new Text("", 0, 0));

    this.editor = new Editor(options.tui, editorTheme);
    this.editor.setText(options.initialText);
    // Disable auto-submit on Enter (we want multiline editing)
    this.editor.disableSubmit = true;
    this.addChild(this.editor);
  }

  getEditor(): Editor {
    return this.editor;
  }

  handleInput(data: string): void {
    // Ctrl+S = save
    if (data === "\x13") {
      this.onSave(this.editor.getText());
      return;
    }
    // Escape = cancel
    if (data === "\x1b") {
      this.onCancel();
      return;
    }
    this.editor.handleInput(data);
  }
}
