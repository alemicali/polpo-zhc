import { Container, SelectList, Text, type SelectItem } from "@mariozechner/pi-tui";
import { selectListTheme, theme } from "../theme.js";

export interface PickerOptions {
  title: string;
  items: SelectItem[];
  maxVisible?: number;
  hint?: string;
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
  /** Custom key handler — called before SelectList handles input.
   *  Return true to consume the key. */
  onKey?: (key: string, selectedItem: SelectItem | undefined) => boolean;
}

export class PickerOverlay extends Container {
  private list: SelectList;
  private customOnKey?: (key: string, selectedItem: SelectItem | undefined) => boolean;

  constructor(options: PickerOptions) {
    super();
    this.customOnKey = options.onKey;

    const header = new Text(theme.header(` ${options.title}`), 0, 0);
    this.addChild(header);
    this.addChild(new Text(theme.dim("─".repeat(60)), 0, 0));

    this.list = new SelectList(
      options.items,
      options.maxVisible ?? 20,
      selectListTheme,
    );
    this.list.onSelect = options.onSelect;
    this.list.onCancel = options.onCancel;
    this.addChild(this.list);

    if (options.hint) {
      this.addChild(new Text("", 0, 0));
      this.addChild(new Text(theme.dim(` ${options.hint}`), 0, 0));
    }
  }

  handleInput(data: string): void {
    if (this.customOnKey) {
      const selected = this.list.getSelectedItem?.() ?? undefined;
      if (this.customOnKey(data, selected)) return;
    }
    this.list.handleInput(data);
  }
}
