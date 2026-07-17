import { describe, expect, test } from "vitest";
import { ALL_ORCHESTRATOR_TOOLS, READ_TOOLS } from "../llm/orchestrator-tools.js";
import type { CodingSessionState, CodingSessionStore } from "../core/coding-session-store.js";
import { ensurePreviewWorkspace, extractServeTargets, parseLocalListeners } from "../server/routes/app-preview.js";

describe("App Preview discovery", () => {
  test("extracts public HTTPS ports backed by local Tailscale Serve proxies", () => {
    const targets = extractServeTargets({
      Web: {
        "machine.example.ts.net:3020": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3020" } },
        },
        "machine.example.ts.net:5173": {
          Handlers: { "/": { Proxy: "http://localhost:5173" } },
        },
        "machine.example.ts.net:8443": {
          Handlers: { "/": { Proxy: "http://10.0.0.20:8080" } },
        },
      },
    });

    expect(targets).toEqual([
      { port: 3020, localPort: 3020, url: "https://machine.example.ts.net:3020/" },
      { port: 5173, localPort: 5173, url: "https://machine.example.ts.net:5173/" },
    ]);
  });

  test("keeps only local listeners and captures their process ids", () => {
    const listeners = parseLocalListeners([
      'LISTEN 0 511 127.0.0.1:3020 0.0.0.0:* users:(("next-server",pid=1234,fd=22))',
      'LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=5678,fd=20))',
      'LISTEN 0 4096 100.112.226.5:3020 0.0.0.0:*',
    ].join("\n"));

    expect(listeners).toEqual([
      { port: 3020, pid: 1234 },
      { port: 5173, pid: 5678 },
    ]);
  });

  test("exposes preview discovery and navigation to the orchestrator", () => {
    expect(READ_TOOLS.has("list_app_previews")).toBe(true);
    expect(ALL_ORCHESTRATOR_TOOLS.some((tool) => tool.name === "list_app_previews")).toBe(true);
    const navigation = ALL_ORCHESTRATOR_TOOLS.find((tool) => tool.name === "navigate_to");
    const schema = JSON.stringify(navigation?.parameters);
    expect(schema).toContain("app_preview");
    expect(schema).toContain('"url"');
  });

  test("reuses a coding workspace already rooted at the preview directory", async () => {
    const state = codingState("/workspace/app");
    let saves = 0;
    const store = memoryCodingStore(state, () => { saves += 1; });

    const result = await ensurePreviewWorkspace(store, "/workspace", "/workspace/app");

    expect(result.workspaceId).toBe("workspace_existing");
    expect(result.state).toBe(state);
    expect(saves).toBe(0);
  });

  test("registers a preview directory as a reusable coding workspace", async () => {
    const store = memoryCodingStore(codingState("/workspace/other"));

    const result = await ensurePreviewWorkspace(store, "/workspace", "/workspace/apps/storefront");
    const workspace = result.state.workspaces.find((item) => item.id === result.workspaceId);
    const terminal = result.state.terminals.find((item) => item.workspaceId === result.workspaceId);

    expect(workspace).toMatchObject({ name: "storefront", cwd: "/workspace/apps/storefront" });
    expect(terminal).toMatchObject({ label: "App Preview", revision: 0 });
    expect(result.state.activeId).toBe(terminal?.id);
  });
});

function codingState(cwd: string): CodingSessionState {
  return {
    workspaces: [{ id: "workspace_existing", name: "Existing", cwd }],
    terminals: [{ id: "terminal_existing", workspaceId: "workspace_existing", label: "", revision: 0 }],
    codeServers: [],
    activeId: "terminal_existing",
  };
}

function memoryCodingStore(initial: CodingSessionState, onSave?: () => void): CodingSessionStore {
  let state = initial;
  return {
    async getState() {
      return { state, initialized: true };
    },
    async saveState(next) {
      onSave?.();
      state = next;
      return state;
    },
  };
}
