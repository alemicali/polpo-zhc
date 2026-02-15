/**
 * TUI entry point — Ink 5 + React + Zustand.
 * Orchestrator in React Context, NOT in Zustand store.
 */

import { createContext, useContext, useState, useEffect } from "react";
import { render } from "ink";
import { FullScreenBox } from "fullscreen-ink";
import { resolve, basename } from "node:path";
import { existsSync } from "node:fs";
import { Orchestrator } from "../core/orchestrator.js";
import { useStore } from "./store.js";
import { bridgeEvents } from "./bridge.js";
import { seg, parseMarkdown } from "./format.js";
import { Shell } from "./components/Shell.js";

// ─── Orchestrator Context ───────────────────────────────

const PolpoContext = createContext<Orchestrator | null>(null);

export function usePolpo(): Orchestrator {
  const ctx = useContext(PolpoContext);
  if (!ctx) throw new Error("usePolpo() must be used within PolpoContext");
  return ctx;
}

// ─── Session Restore ─────────────────────────────────────

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

function restoreSession(orc: Orchestrator, store: ReturnType<typeof useStore.getState>): void {
  try {
    const sessionStore = orc.getSessionStore();
    if (!sessionStore) return;

    const latest = sessionStore.getLatestSession();
    if (!latest) return;

    // Only restore if session is recent
    const age = Date.now() - new Date(latest.updatedAt).getTime();
    if (age > SESSION_TIMEOUT_MS) return;

    const messages = sessionStore.getRecentMessages(latest.id, 50);
    if (messages.length === 0) return;

    // Set active session so chat continues in the same thread
    store.setActiveSessionId(latest.id);

    // Push a separator + previous messages into the stream
    store.pushLine({ type: "system", text: `── Session restored (${messages.length} messages) ──`, ts: new Date().toISOString() });

    for (const msg of messages) {
      if (msg.role === "user") {
        store.pushLine({ type: "user", text: msg.content, ts: msg.ts });
      } else {
        store.pushLine({ type: "response", segs: parseMarkdown(msg.content), ts: msg.ts });
      }
    }

    // Scroll to top so the user sees the conversation from the beginning
    store.scrollUp(Number.MAX_SAFE_INTEGER);
  } catch {
    // Non-critical — start fresh if restore fails
  }
}

// ─── Init Hook ──────────────────────────────────────────

function useOrchestratorInit(workDir: string) {
  const [polpo, setPolpo] = useState<Orchestrator | null>(null);

  useEffect(() => {
    const absDir = resolve(workDir);
    const store = useStore.getState();

    // Create orchestrator — it loads config from .polpo/polpo.json in init()
    const orc = new Orchestrator(absDir);

    // Bridge events → store
    const unbridge = bridgeEvents(orc, store);

    const configPath = resolve(absDir, ".polpo", "polpo.json");
    const hasConfig = existsSync(configPath);

    const defaultTeam = {
      name: "default",
      agents: [
        { name: "dev-1", role: "developer" },
      ],
    };

    const boot = hasConfig
      ? orc.init()
      : orc.initInteractive(basename(absDir), defaultTeam);

    boot.then(() => {
      const config = orc.getConfig();
      if (config?.team.agents[0]) {
        store.setDefaultAgent(config.team.agents[0].name);
      }

      // Restore previous session messages into the stream
      restoreSession(orc, store);

      setPolpo(orc);
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      store.log(`Init error: ${msg}`, [seg(`Init error: ${msg}`, "red")]);
      // Fallback to interactive mode
      orc.initInteractive(basename(absDir), defaultTeam).then(() => {
        restoreSession(orc, store);
        setPolpo(orc);
      });
    });

    // State sync interval
    const syncInterval = setInterval(() => {
      try {
        const state = orc.getStore()?.getState();
        if (state) store.syncState(state, orc.getAllPlans());
      } catch { /* store not ready yet */ }
    }, 1000);

    return () => {
      unbridge();
      clearInterval(syncInterval);
      orc.stop();
    };
  }, [workDir]);

  return polpo;
}

// ─── App ────────────────────────────────────────────────

function App({ workDir }: { workDir: string }) {
  const polpo = useOrchestratorInit(workDir);

  if (!polpo) return null;

  return (
    <PolpoContext.Provider value={polpo}>
      <FullScreenBox>
        <Shell />
      </FullScreenBox>
    </PolpoContext.Provider>
  );
}

// ─── Entry Point ────────────────────────────────────────

export async function startInkTUI(workDir: string = "."): Promise<void> {
  const { waitUntilExit } = render(<App workDir={workDir} />, { exitOnCtrlC: false });
  await waitUntilExit();
}
