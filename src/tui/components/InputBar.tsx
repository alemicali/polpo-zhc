import { Box, Text, useInput } from "ink";
import { useTUIStore } from "../store.js";
import type { CommandContext } from "../context.js";
import { SLASH_COMMANDS } from "../constants.js";


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
 * Input box — cyan-bordered, height 3 — matches old blessed TUI.
 * When processing, the input content is empty (status line handles shimmer).
 */
export function InputBar({ width }: { width: number }) {
  const processing = useTUIStore((s) => s.processing);
  const activeOverlay = useTUIStore((s) => s.activeOverlay);
  const menuType = useTUIStore((s) => s.menuType);
  const buffer = useTUIStore((s) => s.inputBuffer);
  const setBuffer = useTUIStore((s) => s.setInputBuffer);

  useInput((input, key) => {
    if (activeOverlay) return;
    if (processing) return;

    // If command menu is open, handle all menu navigation here
    if (menuType) {
      const store = useTUIStore.getState();
      if (key.escape) {
        store.setMenu(null);
        return;
      }
      if (key.upArrow) {
        store.setMenuIndex(Math.max(0, store.menuIndex - 1));
        return;
      }
      if (key.downArrow) {
        store.setMenuIndex(Math.min(store.menuItems.length - 1, store.menuIndex + 1));
        return;
      }
      if (key.return) {
        const item = store.menuItems[store.menuIndex];
        if (!item) return;
        store.setMenu(null);
        store.setMenuJustClosed(true);

        if (menuType === "command") {
          store.setInputBuffer("");
          import("../commands/router-ink.js").then(({ dispatchInkCommand }) => {
            const handled = dispatchInkCommand(item.value);
            if (!handled) {
              store.logAlways(`Unknown command: ${item.value}`);
            }
          });
        } else if (menuType === "agent") {
          const buf = store.inputBuffer;
          const atPos = buf.lastIndexOf("@");
          if (atPos >= 0) {
            store.setInputBuffer(buf.slice(0, atPos) + item.value + " ");
          } else {
            store.setInputBuffer(buf + item.value + " ");
          }
        }
        return;
      }
      // Backspace: close menu and delete from buffer
      if (key.backspace || key.delete) {
        store.setMenu(null);
        setBuffer(buffer.slice(0, -1));
        return;
      }
      // Any other char: close menu, fall through to input
      if (input && !key.ctrl && !key.meta) {
        store.setMenu(null);
        // Fall through to regular input below
      } else {
        return;
      }
    }

    if (key.return) {
      if (buffer.trim()) {
        handleSubmit(buffer.trim());
        setBuffer("");
      }
      return;
    }

    if (key.escape) {
      setBuffer("");
      useTUIStore.getState().setMenu(null);
      return;
    }

    if (key.backspace || key.delete) {
      setBuffer(buffer.slice(0, -1));
      return;
    }

    // Regular character input
    if (input && !key.ctrl && !key.meta) {
      const newBuf = buffer + input;
      setBuffer(newBuf);

      // "/" at start → open command menu
      if (newBuf.startsWith("/")) {
        openCommandMenu(newBuf);
      }

      // "@" → open mention menu
      if (input === "@") {
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
      const { dispatchInkCommand } = await import("../commands/router-ink.js");
      const handled = dispatchInkCommand(text);
      if (!handled) {
        state.logAlways(`Unknown command: ${text}`);
      }
      return;
    }

    if (state.inputMode === "chat") {
      const ctx = buildCommandContext();
      const { handleChatInput } = await import("../commands/chat-ink.js");
      await handleChatInput(ctx, text);
      return;
    }

    if (state.inputMode === "plan") {
      const ctx = buildCommandContext();
      const { handlePlanInput } = await import("../commands/plan-ink.js");
      await handlePlanInput(ctx, text);
      return;
    }

    // Task mode — submit as task
    const ctx = buildCommandContext();
    const { prepareTask, fallbackDirectCreate } = await import("../commands/task-prep-ink.js");
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

  // Content line (1 line inside the bordered box)
  let content: string;
  if (processing) {
    content = ""; // Empty when processing (StatusLine shows shimmer above)
  } else {
    content = ` ${buffer}█`;
  }
  const paddedContent = content.slice(0, innerW).padEnd(innerW);

  return (
    <Box flexDirection="column" width={width} height={3}>
      <Text color="cyan">{topBorder}</Text>
      <Text>
        <Text color="cyan">│</Text>
        <Text>{paddedContent}</Text>
        <Text color="cyan">│</Text>
      </Text>
      <Text color="cyan">{bottomBorder}</Text>
    </Box>
  );
}
