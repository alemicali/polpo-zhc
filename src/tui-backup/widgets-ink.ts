/**
 * Ink-compatible widget layer — same API as widgets.ts but routes through Zustand store.
 * Commands import from this file instead of widgets.ts in the Ink TUI.
 */

import { useTUIStore } from "./store.js";

// ─── Picker ──────────────────────────────────────────────

export interface PickerOptions {
  title: string;
  items: string[];
  borderColor?: string;
  hint?: string;
  width?: number | string;
  position?: "center" | "fullscreen";
}

/**
 * Show a list picker overlay.
 * Resolves to selected index, or -1 if cancelled.
 */
export function showPicker(opts: PickerOptions): Promise<number> {
  return new Promise((resolve) => {
    useTUIStore.getState().openOverlay("picker", {
      title: opts.title,
      items: opts.items.map((label, i) => ({ label, value: String(i) })),
      borderColor: opts.borderColor,
      onSelect: (index: number, _value: string) => {
        resolve(index);
      },
      onCancel: () => resolve(-1),
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
export function showTextInput(opts: TextInputOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useTUIStore.getState().openOverlay("text-input", {
      title: opts.title,
      initial: opts.initial ?? "",
      onSubmit: (value: string) => resolve(value),
      onCancel: () => resolve(null),
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
 * Multi-line textarea overlay.
 * Resolves to value on save, or null if cancelled.
 */
export function showTextarea(opts: TextareaOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useTUIStore.getState().openOverlay("yaml-editor", {
      title: opts.title,
      initial: opts.initial ?? "",
      onSave: (value: string) => resolve(value),
      onCancel: () => resolve(null),
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
  onTab?: () => string | null;
}

/**
 * Scrollable content viewer with optional action buttons.
 * Resolves to action index, or -1 if escaped.
 */
export function showContentViewer(
  opts: ContentViewerOptions,
): Promise<number> {
  return new Promise((resolve) => {
    useTUIStore.getState().openOverlay("content-viewer", {
      title: opts.title,
      content: opts.content,
      actions: opts.actions,
      onTab: opts.onTab,
      onAction: (index: number) => {
        useTUIStore.getState().closeOverlay();
        resolve(index);
      },
      onClose: () => resolve(-1),
    });
  });
}

// ─── createOverlay compatibility ──────────────────────────
// Commands that use createOverlay directly need to be rewritten.
// This is a thin shim that returns a no-op overlay for compilation.

export interface OverlayResult {
  overlay: any;
  cleanup: () => void;
  onKeypress(handler: (ch: string, key: any) => void): void;
}

export function createOverlay(): OverlayResult {
  const store = useTUIStore.getState();
  return {
    overlay: null,
    cleanup: () => {
      store.closeOverlay();
    },
    onKeypress: (_handler) => {
      // In Ink, keypress is handled by useInput in components
    },
  };
}

export function addHintBar(_overlay: any, _content: string): void {
  // No-op in Ink — hints are rendered in components
}
