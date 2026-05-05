import { useEffect, useState } from "react";
import { GhosttyCore } from "@wterm/ghostty";
import type { TerminalCore } from "@wterm/dom";
import ghosttyWasmUrl from "../../../node_modules/@wterm/ghostty/wasm/ghostty-vt.wasm?url";
import { config } from "@/lib/config";

type TerminalCoreState = {
  core: TerminalCore | null;
  loading: boolean;
  error: string | null;
};

export function useTerminalCore(revision: number): TerminalCoreState {
  const [state, setState] = useState<TerminalCoreState>(() => ({
    core: null,
    loading: config.terminalCore === "ghostty",
    error: null,
  }));

  useEffect(() => {
    if (config.terminalCore === "wterm") {
      setState({ core: null, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState({ core: null, loading: true, error: null });

    withTimeout(GhosttyCore.load({ wasmPath: ghosttyWasmUrl }), 8_000, "Ghostty terminal core timed out while loading.")
      .then((core) => {
        if (!cancelled) setState({ core, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            core: null,
            loading: false,
            error: err instanceof Error ? err.message : "Ghostty terminal core failed to load.",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [revision]);

  return state;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), ms);
    promise
      .then(resolve, reject)
      .finally(() => window.clearTimeout(timeout));
  });
}
