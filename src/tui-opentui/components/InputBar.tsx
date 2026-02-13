import { useKeyboard } from "@opentui/react";
import { useTUIStore } from "../../tui/store.js";
import type { CommandContext } from "../../tui/context.js";
import { SLASH_COMMANDS } from "../../tui/constants.js";

// OpenTUI KeyEvent uses: name, sequence, ctrl, meta, shift, option
// NO "char" or "alt" properties — use sequence for printable chars, meta for Alt

/** Is this a printable character event? */
function isPrintable(key: { sequence: string; ctrl: boolean; meta: boolean }): boolean {
  return key.sequence.length === 1 && key.sequence >= " " && !key.ctrl && !key.meta;
}

/** Build a CommandContext that bridges the Zustand store to the old command interface */
export function buildCommandContext(): CommandContext {
  const s = useTUIStore.getState();
  return {
    orchestrator: s.orchestrator!,
    config: s.config,
    workDir: s.workDir,
    screen: null as any,
    overlayActive: s.activeOverlay !== null,
    scheduleRender: () => {},
    log: (msg: string) => s.log(msg),
    logAlways: (msg: string) => s.logAlways(msg),
    logEvent: (msg: string) => s.logEvent(msg),
    getState: () => s.state,
    loadState: () => s.loadState(),
    getDefaultAgent: () => s.defaultAgent,
    setDefaultAgent: (name: string) => s.setDefaultAgent(name),
    setProcessing: (active: boolean, label?: string) => s.setProcessing(active, label),
    setProcessingDetail: (detail: string) => s.setProcessingDetail(detail),
    getInputMode: () => s.inputMode,
    setInputMode: (mode: "task" | "plan" | "chat") => s.setInputMode(mode),
  };
}

/**
 * Input box — cyan-bordered, height 3.
 * Uses OpenTUI useKeyboard for text entry with keyboard handling for commands.
 */
export function InputBar({ width }: { width: number }) {
  // Render subscriptions — trigger re-render when these change
  const buffer = useTUIStore((s) => s.inputBuffer);
  const processing = useTUIStore((s) => s.processing);

  useKeyboard((key) => {
    // Always read latest state to avoid stale closures
    const s = useTUIStore.getState();
    if (s.activeOverlay) return;
    if (s.processing) return;

    const buf = s.inputBuffer;

    // If command menu is open, handle menu navigation
    if (s.menuType) {
      if (key.name === "escape") {
        s.setMenu(null);
        return;
      }
      if (key.name === "up") {
        s.setMenuIndex(Math.max(0, s.menuIndex - 1));
        return;
      }
      if (key.name === "down") {
        s.setMenuIndex(Math.min(s.menuItems.length - 1, s.menuIndex + 1));
        return;
      }
      if (key.name === "return") {
        const item = s.menuItems[s.menuIndex];
        if (!item) return;
        s.setMenu(null);
        s.setMenuJustClosed(true);

        if (s.menuType === "command") {
          s.setInputBuffer("");
          import("../../tui/commands/router-ink.js").then(({ dispatchInkCommand }) => {
            const handled = dispatchInkCommand(item.value);
            if (!handled) {
              s.logAlways(`Unknown command: ${item.value}`);
            }
          });
        } else if (s.menuType === "agent") {
          const atPos = buf.lastIndexOf("@");
          if (atPos >= 0) {
            s.setInputBuffer(buf.slice(0, atPos) + item.value + " ");
          } else {
            s.setInputBuffer(buf + item.value + " ");
          }
        }
        return;
      }
      // Backspace: close menu and delete from buffer
      if (key.name === "backspace" || key.name === "delete") {
        s.setMenu(null);
        s.setInputBuffer(buf.slice(0, -1));
        return;
      }
      // Any printable char: close menu, fall through
      if (isPrintable(key)) {
        s.setMenu(null);
        // Fall through to regular input
      } else {
        return;
      }
    }

    if (key.name === "return") {
      if (buf.trim()) {
        handleSubmit(buf.trim());
        s.setInputBuffer("");
      }
      return;
    }

    if (key.name === "escape") {
      s.setInputBuffer("");
      s.setMenu(null);
      return;
    }

    if (key.name === "backspace" || key.name === "delete") {
      s.setInputBuffer(buf.slice(0, -1));
      return;
    }

    // Regular character input
    if (isPrintable(key)) {
      const ch = key.sequence;
      const newBuf = buf + ch;
      s.setInputBuffer(newBuf);

      // "/" at start -> open command menu
      if (newBuf.startsWith("/")) {
        openCommandMenu(newBuf);
      }

      // "@" -> open mention menu
      if (ch === "@") {
        openMentionMenu();
      }
    }
  });

  const openCommandMenu = (partial: string) => {
    const filter = partial.slice(1).toLowerCase();
    const entries = Object.entries(SLASH_COMMANDS);
    const filtered = filter
      ? entries.filter(([cmd]) => cmd.slice(1).startsWith(filter))
      : entries;

    if (filtered.length > 0) {
      useTUIStore.getState().setMenu(
        "command",
        filtered.map(([cmd, desc]) => ({
          label: `${cmd.padEnd(16)} ${desc}`,
          value: cmd,
        })),
      );
    } else {
      useTUIStore.getState().setMenu(null);
    }
  };

  const openMentionMenu = () => {
    const store = useTUIStore.getState();
    const team = store.orchestrator?.getTeam();
    if (!team) return;

    const items = team.agents.map((a) => ({
      label: `@${a.name}`,
      value: `@${a.name}`,
      description: a.role || a.adapter,
    }));
    store.setMenu("agent", items);
  };

  const handleSubmit = async (text: string) => {
    const state = useTUIStore.getState();

    if (text.startsWith("/")) {
      const { dispatchInkCommand } = await import("../../tui/commands/router-ink.js");
      const handled = dispatchInkCommand(text);
      if (!handled) {
        state.logAlways(`Unknown command: ${text}`);
      }
      return;
    }

    if (state.inputMode === "chat") {
      const ctx = buildCommandContext();
      const { handleChatInput } = await import("../../tui/commands/chat-ink.js");
      await handleChatInput(ctx, text);
      return;
    }

    if (state.inputMode === "plan") {
      const ctx = buildCommandContext();
      const { handlePlanInput } = await import("../../tui/commands/plan-ink.js");
      await handlePlanInput(ctx, text);
      return;
    }

    // Task mode — submit as task
    const ctx = buildCommandContext();
    const { prepareTask, fallbackDirectCreate } = await import("../../tui/commands/task-prep-ink.js");
    try {
      state.setProcessing(true, "Preparing task...");
      await prepareTask(ctx, text, state.defaultAgent);
    } catch {
      fallbackDirectCreate(ctx, text, state.defaultAgent);
    } finally {
      state.setProcessing(false);
    }
  };

  const innerW = Math.max(1, width - 2);

  // Build border lines
  const topBorder = `┌${"─".repeat(innerW)}┐`;
  const bottomBorder = `└${"─".repeat(innerW)}┘`;

  // Content line
  let content: string;
  if (processing) {
    content = "";
  } else {
    content = ` ${buffer}█`;
  }

  return (
    <box style={{ flexDirection: "column", width, height: 3 }}>
      <text fg="#888888">{topBorder}</text>
      <text>
        <span fg="#888888">│</span>
        <span>{content.slice(0, innerW).padEnd(innerW)}</span>
        <span fg="#888888">│</span>
      </text>
      <text fg="#888888">{bottomBorder}</text>
    </box>
  );
}
