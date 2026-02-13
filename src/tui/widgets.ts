import blessed from "blessed";
import type { WidgetHost } from "./context.js";

// ─── Core Overlay ────────────────────────────────────────

export interface OverlayResult {
  overlay: blessed.Widgets.BoxElement;
  cleanup: () => void;
  /** Register a keypress handler with built-in ready guard */
  onKeypress(handler: (ch: string, key: any) => void): void;
}

/**
 * Create a full-screen overlay with automatic lifecycle management.
 * Sets overlayActive=true, and cleanup resets it.
 */
export function createOverlay(host: WidgetHost): OverlayResult {
  host.overlayActive = true;

  const overlay = blessed.box({
    parent: host.screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    style: { bg: "black" },
    tags: true,
  });

  const keypressHandlers: Array<(ch: string, key: any) => void> = [];
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return; // guard against double cleanup
    cleaned = true;
    host.overlayActive = false;
    for (const handler of keypressHandlers) {
      host.screen.removeListener("keypress", handler);
    }
    keypressHandlers.length = 0;
    overlay.destroy();
    // Force synchronous full redraw to prevent rendering artifacts
    try { host.screen.alloc(); } catch { /* older blessed versions */ }
    host.screen.render();
  };

  const onKeypress = (handler: (ch: string, key: any) => void) => {
    let ready = false;
    setImmediate(() => { ready = true; });
    const wrappedHandler = (ch: string, key: any) => {
      if (!ready) return;
      handler(ch, key);
    };
    host.screen.on("keypress", wrappedHandler);
    keypressHandlers.push(wrappedHandler);
  };

  return { overlay, cleanup, onKeypress };
}

/** Add a hint bar at the bottom of an overlay */
export function addHintBar(overlay: blessed.Widgets.BoxElement, content: string): void {
  blessed.box({
    parent: overlay,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    content,
    style: { bg: "black", fg: "grey" },
  });
}

// ─── Picker ──────────────────────────────────────────────

export interface PickerOptions {
  title: string;
  items: string[];
  borderColor?: string;
  selectedStyle?: Record<string, any>;
  hint?: string;
  width?: number | string;
  position?: "center" | "fullscreen";
}

/**
 * Show a list picker overlay.
 * Resolves to selected index, or -1 if cancelled.
 */
export function showPicker(host: WidgetHost, opts: PickerOptions): Promise<number> {
  return new Promise((resolve) => {
    const { overlay, cleanup, onKeypress } = createOverlay(host);
    const borderColor = opts.borderColor ?? "cyan";
    const selectedStyle = opts.selectedStyle ?? { bg: "blue", fg: "white", bold: true };
    const width = opts.width ?? "60%";
    const isFullscreen = opts.position === "fullscreen";

    const list = blessed.list({
      parent: overlay,
      top: isFullscreen ? 0 : "center",
      left: isFullscreen ? 0 : "center",
      width: isFullscreen ? "100%" : width,
      height: isFullscreen ? "100%-1" : Math.min(opts.items.length + 2, 20),
      items: opts.items,
      tags: true,
      border: { type: "line" },
      label: ` ${opts.title} `,
      style: {
        bg: "black",
        border: { fg: borderColor },
        selected: selectedStyle,
        item: { bg: "black" },
      },
      keys: false,
      vi: false,
      mouse: true,
      scrollable: true,
    });

    addHintBar(overlay, opts.hint ?? " {cyan-fg}Enter{/cyan-fg} {grey-fg}select{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

    list.select(0);
    list.focus();
    host.scheduleRender();

    const done = (index: number) => {
      cleanup();
      resolve(index);
    };

    // Manual keyboard nav (blessed list keys: false)
    onKeypress((_ch, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        list.up(1);
        host.scheduleRender();
      } else if (key.name === "down" || key.name === "j") {
        list.down(1);
        host.scheduleRender();
      } else if (key.name === "return" || key.name === "enter") {
        const sel = (list as any).selected ?? 0;
        done(sel);
      } else if (key.name === "escape") {
        done(-1);
      }
    });

    // Mouse select
    list.on("select", (_item: any, index: number) => {
      done(index);
    });
  });
}

// ─── Text Input ──────────────────────────────────────────

export interface TextInputOptions {
  title: string;
  initial?: string;
  hint?: string;
}

/**
 * Single-line text input overlay.
 * Resolves to trimmed string, or null if cancelled.
 */
export function showTextInput(host: WidgetHost, opts: TextInputOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, cleanup, onKeypress } = createOverlay(host);

    const box = blessed.box({
      parent: overlay,
      top: "center",
      left: "center",
      width: "80%",
      height: 3,
      border: { type: "line" },
      tags: true,
      label: ` {bold}${opts.title}{/bold} `,
      style: { bg: "black", fg: "white", border: { fg: "cyan" } },
    });

    addHintBar(overlay, opts.hint ?? " {cyan-fg}Enter{/cyan-fg} {grey-fg}confirm{/grey-fg}  {cyan-fg}Escape{/cyan-fg} {grey-fg}cancel{/grey-fg}");

    let buf = opts.initial ?? "";
    const cursor = "{white-fg}_{/white-fg}";
    box.setContent(` ${buf}${cursor}`);
    host.scheduleRender();

    const done = (result: string | null) => {
      cleanup();
      resolve(result);
    };

    onKeypress((ch, key) => {
      if (!key) return;
      if (key.name === "return" || key.name === "enter") {
        done(buf.trim());
        return;
      }
      if (key.name === "escape") {
        done(null);
        return;
      }
      if (key.name === "backspace") {
        buf = buf.slice(0, -1);
      } else if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
        buf += ch;
      }
      box.setContent(` ${buf}${cursor}`);
      host.scheduleRender();
    });
  });
}

// ─── Textarea ────────────────────────────────────────────

export interface TextareaOptions {
  title: string;
  initial?: string;
  borderColor?: string;
}

/**
 * Multi-line textarea overlay (for YAML editing, system prompts).
 * Resolves to value on Ctrl+S, or null on Escape.
 */
export function showTextarea(host: WidgetHost, opts: TextareaOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { overlay, cleanup } = createOverlay(host);
    const borderColor = opts.borderColor ?? "yellow";

    const editor = blessed.textarea({
      parent: overlay,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%-1",
      value: opts.initial ?? "",
      inputOnFocus: false,
      border: { type: "line" },
      tags: true,
      label: ` ${opts.title}  {grey-fg}Ctrl+S save  Escape cancel{/grey-fg} `,
      style: { bg: "black", fg: "white", border: { fg: borderColor } },
      keys: true,
      mouse: true,
      scrollable: true,
    });

    editor.focus();
    editor.readInput(() => {});
    host.scheduleRender();

    const done = (result: string | null) => {
      cleanup();
      resolve(result);
    };

    editor.key(["C-s"], () => {
      done(editor.getValue());
    });

    editor.key(["escape"], () => {
      done(null);
    });
  });
}

// ─── Content Viewer ──────────────────────────────────────

export interface ContentViewerOptions {
  title: string;
  content: string;
  actions?: string[];
  hint?: string;
  borderColor?: string;
  /** If true, allow Tab to toggle between different views */
  onTab?: () => string | null;
}

/**
 * Scrollable content viewer with optional action buttons at bottom.
 * Resolves to action index, or -1 if escaped.
 */
export function showContentViewer(
  host: WidgetHost,
  opts: ContentViewerOptions,
): Promise<number> {
  return new Promise((resolve) => {
    const { overlay, cleanup, onKeypress } = createOverlay(host);
    const borderColor = opts.borderColor ?? "cyan";
    const hasActions = opts.actions && opts.actions.length > 0;

    const contentBox = blessed.box({
      parent: overlay,
      top: 0,
      left: 0,
      width: "100%",
      height: hasActions ? "100%-4" : "100%-1",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "grey" } },
      tags: true,
      border: { type: "line" },
      label: ` ${opts.title} `,
      style: { bg: "black", fg: "white", border: { fg: borderColor } },
      keys: true,
      vi: false,
      mouse: true,
    });

    contentBox.setContent(opts.content);

    if (hasActions) {
      const actionList = blessed.list({
        parent: overlay,
        bottom: 1,
        left: "center",
        width: "80%",
        height: opts.actions!.length + 2,
        items: opts.actions!,
        tags: true,
        border: { type: "line" },
        style: {
          bg: "black",
          border: { fg: borderColor },
          selected: { bg: "blue", fg: "white", bold: true },
          item: { bg: "black" },
        },
        keys: false,
        vi: false,
        mouse: true,
      });

      actionList.select(0);
      actionList.focus();

      onKeypress((_ch, key) => {
        if (!key) return;
        if (key.name === "up" || key.name === "k") {
          actionList.up(1);
          host.scheduleRender();
        } else if (key.name === "down" || key.name === "j") {
          actionList.down(1);
          host.scheduleRender();
        } else if (key.name === "return" || key.name === "enter") {
          const sel = (actionList as any).selected ?? 0;
          cleanup();
          resolve(sel);
        } else if (key.name === "escape") {
          cleanup();
          resolve(-1);
        } else if (key.full === "tab" && opts.onTab) {
          const newContent = opts.onTab();
          if (newContent !== null) {
            contentBox.setContent(newContent);
            host.scheduleRender();
          }
        }
      });

      actionList.on("select", (_item: any, index: number) => {
        cleanup();
        resolve(index);
      });
    } else {
      contentBox.focus();

      addHintBar(overlay, opts.hint ?? " {cyan-fg}Escape{/cyan-fg} {grey-fg}close{/grey-fg}  {cyan-fg}↑↓{/cyan-fg} {grey-fg}scroll{/grey-fg}");

      onKeypress((_ch, key) => {
        if (!key) return;
        if (key.name === "escape") {
          cleanup();
          resolve(-1);
        } else if (key.name === "up") {
          contentBox.scroll(-1);
          host.scheduleRender();
        } else if (key.name === "down") {
          contentBox.scroll(1);
          host.scheduleRender();
        } else if (key.full === "tab" && opts.onTab) {
          const newContent = opts.onTab();
          if (newContent !== null) {
            contentBox.setContent(newContent);
            host.scheduleRender();
          }
        }
      });
    }

    host.scheduleRender();
  });
}
