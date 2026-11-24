import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// the terminal itself (xterm + WebSocket) is the coding page's; here: what it is asked to open
const terminals: Array<Record<string, unknown>> = [];
vi.mock("@/pages/coding/terminal-session", () => ({
  TerminalSession: (props: Record<string, unknown>) => { terminals.push(props); return <div data-testid="fake-terminal" />; },
}));
const agentState = { agent: { name: "dev", engine: undefined as unknown, defaultComputer: undefined as string | undefined } };
vi.mock("../src/components/agents/agent-detail-context", () => ({
  useAgentDetail: () => ({ state: agentState, actions: { refetch: async () => {} }, meta: { agentName: "dev" } }),
}));

import { CliAccountsSection } from "../src/components/config/cli-accounts-section";
import { AgentEngineCard } from "../src/components/agents/agent-engine-card";
import { agentEngineId, authBrand, engineBrand, engineLabel } from "../src/lib/run-context";

let root: Root;
let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON request bodies, read in assertions
let calls: Array<{ method: string; path: string; body?: any }>;
const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
const accounts = [
  { id: "ada-claude", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-claude", owner: "ada@example.com", label: "Ada Max", agents: [], manageable: true,
    report: { installed: true, version: "2.1.400", status: { signedIn: false } } },
  { id: "bob-codex", cli: "codex", computer: "host", configDir: "~/.polpo-cli/codex/bob-codex", owner: "bob@example.com", agents: ["rev"], manageable: false,
    report: { installed: false } },
];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  calls = [];
  terminals.length = 0;
  agentState.agent = { name: "dev", engine: undefined, defaultComputer: undefined };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path, body });
    if (path === "/harnesses/cli/accounts") return ok({ accounts, allowInstanceCodex: false });
    if (path === "/harnesses/cli/accounts/ada-claude/login") return ok({ mode: "terminal", terminal: { agent: "cli-login", cli_account: "ada-claude" }, command: "CLAUDE_CONFIG_DIR=~/.polpo-cli/claude/ada-claude claude auth login" });
    if (path === "/harnesses") return ok({ allowHost: false, computers: [], harnesses: [{ id: "claude-code", name: "Claude Code", enabled: false, agents: [] }] });
    if (path === "/harnesses/sessions") return ok({ sessions: [] });
    if (path === "/computers") return ok({ computers: [] });
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
function change(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const q = <T extends Element>(sel: string) => (document.querySelector<T>(sel))!;

test("CLI accounts: status per account, sign-in opens the account's login terminal, install when missing, only the owner manages", async () => {
  await act(async () => root.render(<MemoryRouter><CliAccountsSection /></MemoryRouter>));
  await flush();
  const ada = q<HTMLElement>('[data-testid="cli-account-ada-claude"]');
  expect(ada.textContent).toContain("Ada Max");
  expect(ada.textContent).toContain("not signed in");
  const bob = q<HTMLElement>('[data-testid="cli-account-bob-codex"]');
  expect(bob.textContent).toContain("not installed");
  expect(bob.textContent).toContain("Install");
  expect(bob.querySelector('[data-testid="cli-signin-bob-codex"]')).toBeNull();

  await act(async () => q<HTMLButtonElement>('[data-testid="cli-signin-ada-claude"]').click());
  await flush();
  expect(calls.some((c) => c.path === "/harnesses/cli/accounts/ada-claude/login")).toBe(true);
  expect(terminals.at(-1)).toMatchObject({ agent: "cli-login", cliAccount: "ada-claude" });
  expect(q<HTMLElement>('[data-testid="cli-signin-dialog"]').textContent).toContain("claude auth login");
});

test("CLI accounts: adding one posts the CLI and computer, never a secret", async () => {
  await act(async () => root.render(<MemoryRouter><CliAccountsSection /></MemoryRouter>));
  await flush();
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="CLI"]'), "codex"));
  await act(async () => change(q<HTMLInputElement>('input[aria-label="Account label"]'), "My Plus"));
  await act(async () => q<HTMLButtonElement>('[data-testid="cli-account-add"]').click());
  await flush();
  expect(calls.find((c) => c.method === "POST" && c.path === "/harnesses/cli/accounts")?.body).toEqual({ cli: "codex", computer: "host", label: "My Plus" });
});

test("agent engine: picks Claude Code (CLI) with an account and saves { type: cli }", async () => {
  await act(async () => root.render(<MemoryRouter><AgentEngineCard /></MemoryRouter>));
  await flush();
  const engine = q<HTMLSelectElement>('select[aria-label="Engine"]');
  expect([...engine.options].map((o) => o.value)).toEqual(["polpo", "cli:claude", "cli:codex"]);
  await act(async () => change(engine, "cli:claude"));
  await act(async () => change(q<HTMLSelectElement>('select[aria-label="CLI account"]'), "ada-claude"));
  expect(q<HTMLElement>('[data-testid="agent-engine-card"]').textContent).toContain("not signed in");
  expect(q<HTMLElement>('[data-testid="agent-cli-note"]').textContent).toContain("only the work of its account's owner");
  await act(async () => change(q<HTMLInputElement>('input[aria-label="CLI model"]'), "opus"));
  const save = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Save engine"))!;
  await act(async () => save.click());
  await flush();
  expect(calls.find((c) => c.method === "PATCH" && c.path === "/agents/dev")?.body).toEqual({ engine: { type: "cli", cli: "claude", account: "ada-claude", model: "opus" }, publish: false });
  // no model-connection test for a CLI (its account's status says if it can run)
  expect(calls.some((c) => c.path === "/harnesses/test")).toBe(false);
});

test("run labels and marks for CLI runs", () => {
  expect(engineLabel("claude-cli")).toBe("Claude Code (CLI)");
  expect(engineBrand("codex-cli")).toBe("codex");
  expect(agentEngineId({ type: "cli", cli: "codex" })).toBe("codex-cli");
  expect(authBrand("subscription", "claude-cli")).toBe("anthropic");
});
