// ─── Notes & Logo ────────────────────────────────────────

export const LOGO_LINES = [
  "       ╔═══════════════════════════════════╗",
  "       ║                                   ║",
  "       ║      O R C H E S T R A            ║",
  "       ║                                   ║",
  "       ║   AI Agent Orchestration Framework ║",
  "       ║                                   ║",
  "       ╚═══════════════════════════════════╝",
];

// ─── Provider & Model Options ────────────────────────────

export interface ProviderOption {
  label: string;
  value: string;
  available: boolean;
}

export const PROVIDERS: ProviderOption[] = [
  { label: "Claude Code", value: "claude-sdk", available: true },
  { label: "OpenCode", value: "opencode", available: false },
  { label: "OpenClaw", value: "openclaw", available: false },
  { label: "AI SDK Vercel", value: "ai-sdk-vercel", available: false },
];

export interface ModelOption {
  label: string;
  value: string;
  adapter: string;
}

export const MODELS: ModelOption[] = [
  { label: "Claude Sonnet 4.5", value: "claude-sonnet-4-5-20250929", adapter: "claude-sdk" },
  { label: "Claude Opus 4.6", value: "claude-opus-4-6", adapter: "claude-sdk" },
  { label: "Claude Haiku 4.5", value: "claude-haiku-4-5-20251001", adapter: "claude-sdk" },
];

// ─── Slash Commands & Shortcuts ──────────────────────────

export const SLASH_COMMANDS: Record<string, string> = {
  "/status": "Detailed task status",
  "/result": "Show last task result",
  "/inspect": "Browse tasks & plans",
  "/plans": "List & manage saved plans",
  "/resume": "Resume interrupted plans",
  "/edit-plan": "Edit a running plan",
  "/reassess": "Re-run assessment on task",
  "/team": "Show / manage team",
  "/abort": "Abort running plan/task",
  "/clear-tasks": "Clear finished tasks",
  "/tasks": "Browse tasks & plans",
  "/clear": "Clear log",
  "/memory": "Edit project memory",
  "/logs": "Browse session logs",
  "/config": "Show configuration",
  "/help": "Commands & shortcuts",
  "/quit": "Exit Orchestra",
};

export const SHORTCUTS: Record<string, string> = {
  "Alt+T": "Toggle Direct/Plan mode",
  "Ctrl+O": "Toggle task panel",
  "Ctrl+L": "Toggle verbose log",
  "Ctrl+C": "Quit",
  "Enter": "Submit",
  "Escape": "Clear input",
};

