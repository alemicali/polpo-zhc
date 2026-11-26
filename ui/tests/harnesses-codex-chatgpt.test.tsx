import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@/hooks/use-vault-catalog", () => ({
  useVaultCatalog: () => ({ entries: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
// the terminal itself (xterm + a WebSocket) is not under test: what it is asked to open is
vi.mock("@/pages/coding/terminal-session", () => ({
  TerminalSession: (p: { agent?: string; harnessAgent?: string }) => <div data-testid="fake-terminal" data-agent={p.agent} data-harness-agent={p.harnessAgent} />,
}));

import { HarnessesSection } from "../src/components/config/harnesses-section";
import { CODEX_AUTH_LABELS, cleanHarnessSettings, type HarnessesOverview } from "../src/lib/harnesses-api";

let root: Root;
let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON request bodies, read in assertions
let calls: Array<{ method: string; path: string; body?: any }>;
let overview: HarnessesOverview;
const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
const ref = { owner: "cody", service: "codex-chatgpt" };

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls = [];
  overview = {
    allowHost: false, computers: ["nina"], relay: { available: true, url: "https://p.example/api/v1/harness-relay/", path: "/api/v1/harness-relay/" },
    harnesses: [
      { id: "claude-code", name: "Claude Code", enabled: false, agents: [] },
      { id: "codex", name: "Codex", enabled: true, auth: "chatgpt", credentialRef: ref, credentialFound: false, settings: { auth: "chatgpt", credentialRef: ref }, chatgpt: { signedIn: false }, agents: ["cody"] },
      { id: "opencode", name: "OpenCode", enabled: false, agents: [] },
    ],
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/harnesses") return ok(overview);
    if (path === "/harnesses/sessions") return ok({ sessions: [] });
    if (path === "/harnesses/cli/accounts") return ok({ accounts: [], allowInstanceCodex: false, clis: [] });
    if (path === "/harnesses/codex/chatgpt-login") {
      return ok({ mode: "terminal", agent: "cody", computer: "nina", terminal: { agent: "codex-chatgpt-login", harness_agent: "cody" }, command: "codex login --device-auth", codexHome: "$HOME/.polpo-harness/codex/cody", credentialRef: ref, signedIn: false, note: "n" });
    }
    if (path === "/harnesses/codex/chatgpt-login/capture") return ok({ agent: "cody", computer: "nina", credentialRef: ref, result: "updated", message: "Signed in with ChatGPT: the login is saved in the vault.", signedIn: true });
    return ok({});
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); });

test("ChatGPT sign-in is a Codex auth; its setting keeps the vault entry of the login", () => {
  expect(CODEX_AUTH_LABELS.chatgpt).toBe("ChatGPT sign-in");
  expect(cleanHarnessSettings({ enabled: ["codex"], codex: { auth: "chatgpt", credentialRef: ref } }).codex).toEqual({ auth: "chatgpt", credentialRef: ref });
  expect(cleanHarnessSettings({ enabled: [], codex: { auth: "chatgpt" } }).codex).toBeUndefined();
});

test("Settings → Harnesses → Codex: not signed in, sign in an agent in a terminal on its computer, save the sign-in", async () => {
  await act(async () => root.render(<MemoryRouter><HarnessesSection /></MemoryRouter>));
  await flush();
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Codex authentication"]')!;
  expect(select.value).toBe("chatgpt");
  const card = container.querySelector('[data-testid="codex-chatgpt"]')!;
  expect(card.querySelector('[data-testid="codex-chatgpt-status"]')!.textContent).toBe("not signed in");
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Codex ChatGPT vault entry"]')!.value).toBe("codex-chatgpt");
  const button = [...card.querySelectorAll("button")].find((b) => /Sign in with ChatGPT/.test(b.textContent ?? ""))!;
  await act(async () => button.click());
  await flush();
  expect(calls.find((c) => c.path === "/harnesses/codex/chatgpt-login" && c.method === "POST")?.body).toEqual({ agent: "cody" });
  const term = document.body.querySelector('[data-testid="fake-terminal"]')!;
  expect(term.getAttribute("data-agent")).toBe("codex-chatgpt-login");
  expect(term.getAttribute("data-harness-agent")).toBe("cody");
  const save = document.body.querySelector<HTMLButtonElement>('button[aria-label="Save ChatGPT sign-in"]')!;
  await act(async () => save.click());
  await flush();
  expect(calls.some((c) => c.path === "/harnesses/codex/chatgpt-login/capture" && c.body?.agent === "cody")).toBe(true);
  expect(document.body.textContent).toContain("the login is saved in the vault");
});

test("signed in: the badge says so, never the login", async () => {
  overview.harnesses[1] = { ...overview.harnesses[1]!, chatgpt: { signedIn: true, lastRefresh: "2026-11-20T10:00:00.000Z" } };
  await act(async () => root.render(<MemoryRouter><HarnessesSection /></MemoryRouter>));
  await flush();
  expect(container.querySelector('[data-testid="codex-chatgpt-status"]')!.textContent).toBe("signed in");
});
