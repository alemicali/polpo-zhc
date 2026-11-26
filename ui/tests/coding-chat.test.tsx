/**
 * The Coding app: a Claude Code / Codex session drawn as a chat (the chat's own parts: the user's
 * bubble, text, tool calls with an edit's diff and a command's output, approvals to answer inline,
 * the engine badge, the sign-in hint), the page without its own sidebar (sessions in the sheet when
 * no navigation shows them), new claude sessions created as chats, and older terminal sessions
 * still terminals.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CodingChatSession } from "@polpo-ai/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const terminals: Array<Record<string, unknown>> = [];
vi.mock("@/pages/coding/terminal-session", () => ({
  TerminalSession: (props: Record<string, unknown>) => { terminals.push(props); return <div data-testid="fake-terminal" data-session={String(props.sessionId)} />; },
}));
vi.mock("@/pages/coding/right-panel", () => ({ RightPanel: () => <div data-testid="right-panel" /> }));

const chat = {
  session: null as CodingChatSession | null,
  approve: vi.fn(async (id: string) => ({ id, state: "approved" })),
  deny: vi.fn(async (id: string) => ({ id, state: "denied" })),
  send: vi.fn(async () => ({ steered: false })),
  stop: vi.fn(async () => {}),
};
vi.mock("@polpo-ai/react", () => ({
  useCodingChat: (id: string | undefined) => ({
    session: id ? chat.session : null, isLoading: false, error: null, live: true,
    send: chat.send, stop: chat.stop, approve: chat.approve, deny: chat.deny, refetch: async () => {},
  }),
  useCodingChats: () => ({ chats: [], isLoading: false, error: null, refetch: async () => {}, createChat: vi.fn(), deleteChat: vi.fn() }),
}));

import { CodingChatPane } from "../src/pages/coding/coding-chat";
import { CodingPage } from "../src/pages/coding";
import { resetCodingStoreForTests } from "../src/pages/coding/use-coding-state";

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 170 };
function session(patch: Partial<CodingChatSession> = {}): CodingChatSession {
  return {
    id: "cc_abc12345", kind: "claude", title: "Session 1", cwd: "/work/wt/lisbon", branch: "lisbon", owner: "ada@example.com", account: "ada-max",
    model: "claude-opus-4-5", status: "awaiting-approval", usage, costUsd: 0.05, turns: 1, createdAt: "2026-11-26T10:00:00Z", updatedAt: "2026-11-26T10:01:00Z",
    messages: [
      { id: "m1", role: "user", ts: "2026-11-26T10:00:00Z", text: "Fix the tests and push", kind: "prompt" },
      {
        id: "m2", role: "assistant", ts: "2026-11-26T10:00:05Z", streaming: true,
        segments: [
          { type: "text", text: "Looking at the failing test." },
          { type: "tool", tool: { id: "t1", name: "Edit", input: { file_path: "/work/wt/lisbon/src/a.ts" }, diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;", output: "The file was updated", state: "completed" } },
          { type: "tool", tool: { id: "t2", name: "Bash", input: { command: "pnpm test" }, output: "3 passed", state: "completed" } },
          { type: "tool", tool: { id: "t3", name: "Bash", input: { command: "git push --force origin lisbon" }, state: "running" } },
          { type: "approval", approvalId: "ap_1" },
        ],
      },
    ],
    approvals: [{ id: "ap_1", tool: "Bash", summary: "$ git push --force origin lisbon", reason: "Force-pushes to a remote", category: "git-push", state: "pending", requestedAt: "2026-11-26T10:00:06Z" }],
    ...patch,
  };
}

const renderPane = (props: Partial<Parameters<typeof CodingChatPane>[0]> = {}) => render(
  <MemoryRouter><CodingChatPane chatId="cc_abc12345" kind="claude" active {...props} /></MemoryRouter>,
);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  chat.session = session();
  terminals.length = 0;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("a coding chat", () => {
  test("messages, tool cards (an edit's diff, a command's output), the engine badge", () => {
    renderPane();
    expect(screen.getByTestId("chat-user-bubble").textContent).toContain("Fix the tests and push");
    expect(screen.getByText("Looking at the failing test.")).toBeTruthy();
    const badge = screen.getByTestId("coding-chat-badge");
    expect(badge.textContent).toContain("Claude Code · CLI");
    expect(badge.textContent).toContain("claude-opus-4-5");
    expect(badge.textContent).toContain("170 tokens");
    // the tool lines, in Claude Code's names
    fireEvent.click(screen.getByTestId("tool-call-group-line"));
    expect(screen.getByText(/Edited file · \/work\/wt\/lisbon\/src\/a\.ts/)).toBeTruthy();
    const lines = screen.getAllByTestId("tool-call-line");
    fireEvent.click(lines.find((l) => /Edited file/.test(l.textContent ?? ""))!);
    const diff = screen.getByTestId("tool-call-diff");
    expect(diff.textContent).toContain("+const b = 3;");
    expect(diff.querySelector(".text-success")?.textContent).toBe("+const b = 3;");
    fireEvent.click(lines.find((l) => /pnpm test/.test(l.textContent ?? ""))!);
    expect(screen.getByText("$ pnpm test")).toBeTruthy();
    expect(screen.getByText("3 passed")).toBeTruthy();
  });

  test("a risky action asks inline: Approve and Deny answer it", async () => {
    renderPane();
    const card = screen.getByTestId("coding-approval");
    expect(card.dataset.state).toBe("pending");
    expect(card.textContent).toContain("Force-pushes to a remote");
    expect(card.textContent).toContain("$ git push --force origin lisbon");
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: /Approve/ })); });
    expect(chat.approve).toHaveBeenCalledWith("ap_1");
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: /Deny/ })); });
    expect(chat.deny).toHaveBeenCalledWith("ap_1");
  });

  test("while it works the composer steers and Stop stops", async () => {
    renderPane();
    expect(screen.getByPlaceholderText("Steer Claude Code while it works…")).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop" })); });
    expect(chat.stop).toHaveBeenCalled();
  });

  test("an answered approval stays as a record; no account: how to sign in", () => {
    chat.session = session({ status: "idle", approvals: [{ ...session().approvals[0]!, state: "denied" }] });
    const { unmount } = renderPane();
    expect(screen.getByTestId("coding-approval").dataset.state).toBe("denied");
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
    unmount();
    chat.session = session({ status: "error", errorKind: "no-account", messages: [], approvals: [], lastError: "Claude Code (CLI): you have no account on this server." });
    renderPane();
    const hint = screen.getByTestId("coding-chat-signin");
    expect(hint.textContent).toContain("Sign in to Claude Code with your own account");
    expect(within(hint).getByRole("link", { name: "Open CLI accounts" }).getAttribute("href")).toBe("/config?section=harnesses");
  });
});

describe("the Coding page", () => {
  const workspace = { id: "w1", name: "polpo", cwd: "/work/polpo" };
  function stubFetch() {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      calls.push({ method: init?.method ?? "GET", path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
      if (path === "/api/v1/terminal/status") return ok({ enabled: true, workDir: "/work", agentWorkDir: "/work", shell: "bash" });
      if (path === "/api/v1/coding/chats" && init?.method === "POST") return new Response(JSON.stringify({ ok: true, data: { id: "cc_new12345" } }), { status: 201 });
      return new Response(JSON.stringify({ ok: false, error: "nope" }), { status: 404 });
    }));
    return calls;
  }

  test("no sidebar of its own; an older terminal session stays a terminal, a chat session is a chat; + starts a Claude Code chat", async () => {
    stubFetch();
    resetCodingStoreForTests({
      workspaces: [workspace],
      terminals: [
        { id: "t-old", workspaceId: "w1", label: "Old claude", revision: 0, agentKind: "claude", agentSessionId: "uuid-1" },
        { id: "t-chat", workspaceId: "w1", label: "Chat", revision: 0, agentKind: "claude", chatId: "cc_abc12345" },
      ],
      activeId: "t-old",
    });
    render(<MemoryRouter initialEntries={["/coding"]}><CodingPage /></MemoryRouter>);
    await screen.findByTestId("fake-terminal");
    expect(screen.queryByTestId("coding-nav")).toBeNull();
    expect(terminals.some((t) => t.sessionId === "t-old" && t.agent === "claude" && t.agentSessionId === "uuid-1")).toBe(true);
    expect(terminals.some((t) => t.sessionId === "t-chat")).toBe(false);
    expect(screen.getByTestId("coding-chat")).toBeTruthy();

    // no navigation shows the sessions here: the sheet does
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Projects and sessions" })); });
    const sheet = await screen.findByTestId("coding-sessions-sheet");
    expect(within(sheet).getByTestId("coding-nav")).toBeTruthy();
    expect(within(sheet).getAllByTestId("coding-session-row").map((r) => r.textContent)).toEqual(["Old claude", "Chat"]);
  });

  test("a new Claude Code session from the quick start is a chat created on the server in the worktree", async () => {
    const calls = stubFetch();
    resetCodingStoreForTests({
      workspaces: [workspace],
      terminals: [{ id: "t1", workspaceId: "w1", label: "Shell", revision: 0 }],
      activeId: "t1",
      pendingWorkspaces: [{ key: "w1::lisbon-x1::/work/polpo-wt/lisbon-x1", projectId: "w1", branch: "lisbon-x1", cwd: "/work/polpo-wt/lisbon-x1", label: "lisbon-x1" }],
      activePendingKey: "w1::lisbon-x1::/work/polpo-wt/lisbon-x1",
    });
    render(<MemoryRouter initialEntries={["/coding"]}><CodingPage /></MemoryRouter>);
    const claude = await screen.findByRole("button", { name: /Claude Code as a chat/ });
    await act(async () => { fireEvent.click(claude); });
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/v1/coding/chats")).toBe(true));
    expect(calls.find((c) => c.path === "/api/v1/coding/chats")!.body).toMatchObject({ kind: "claude", cwd: "/work/polpo-wt/lisbon-x1", branch: "lisbon-x1", workspaceId: "w1" });
    await screen.findByTestId("coding-chat");
  });
});
