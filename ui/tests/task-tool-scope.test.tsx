import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TaskToolScopeCard } from "../src/components/tasks/task-tool-scope";
import {
  agentBuiltinTools, agentConnectors, describeToolScope, draftFromScope, draftProblems, scopeFromDraft, type TaskToolScope,
} from "../src/lib/task-tool-scope";
import type { Connector } from "../src/lib/connectors-api";

function connector(id: string, name: string, agents: string[] | "*", extra: Partial<Connector> & { account?: string } = {}): Connector {
  return {
    id, name, kind: "mcp", transport: { type: "http", url: `https://mcp.${id}.com/mcp` }, auth: { type: "oauth" }, access: { agents, polpo: false },
    enabled: true, createdAt: "2026-11-19T00:00:00Z", status: "connected",
    secrets: { bearerToken: false, headers: [], clientSecret: false, values: [], oauth: { authorized: true, clientRegistered: true, pending: false } },
    ...extra,
  } as Connector;
}

const CONNECTORS = [
  connector("linear", "Linear", "*", { toolPolicy: { delete_issue: "off" } }),
  connector("gmail", "Gmail", ["pm"]),
  connector("gmail-2", "Gmail 2", ["pm"], { account: "info@acme.com" }),
  connector("notion", "Notion", ["dev"]),
  connector("off", "Off", "*", { enabled: false }),
];

describe("helpers", () => {
  test("the agent's connectors: on, granted, not narrowed to nothing", () => {
    expect(agentConnectors(CONNECTORS, { name: "pm" }).map((c) => c.id)).toEqual(["linear", "gmail", "gmail-2"]);
    expect(agentConnectors(CONNECTORS, { name: "pm", connectorTools: { gmail: [] } }).map((c) => c.id)).toEqual(["linear", "gmail-2"]);
    expect(agentConnectors(CONNECTORS, undefined)).toEqual([]);
  });

  test("built-in tools offered: the agent's allowedTools without connector patterns, else the defaults", () => {
    expect(agentBuiltinTools({ allowedTools: ["read", "browser_*", "mcp__linear__*"] })).toEqual(["read", "browser_*"]);
    expect(agentBuiltinTools({})).toContain("bash");
  });

  test("draft ⇄ scope round trip; inherit saves null", () => {
    const available = agentConnectors(CONNECTORS, { name: "pm" });
    expect(draftFromScope(undefined, available)).toEqual({ mode: "inherit", connectors: {}, builtin: null });
    expect(scopeFromDraft({ mode: "inherit", connectors: { linear: "*" }, builtin: ["read"] })).toBeNull();
    const scope: TaskToolScope = { connectors: ["linear", "gmail-2"], connectorTools: { linear: ["create_issue"] }, allowedTools: ["read"] };
    const draft = draftFromScope(scope, available);
    expect(draft).toEqual({ mode: "restrict", connectors: { linear: ["create_issue"], "gmail-2": "*" }, builtin: ["read"] });
    expect(scopeFromDraft(draft)).toEqual(scope);
    expect(scopeFromDraft({ mode: "restrict", connectors: {}, builtin: null })).toEqual({ connectors: "none" });
    // a scope without connectors: every connector the agent has
    expect(draftFromScope({ allowedTools: ["read"] }, available).connectors).toEqual({ linear: "*", gmail: "*", "gmail-2": "*" });
    expect(draftProblems({ mode: "restrict", connectors: { linear: [] }, builtin: null })).toEqual([expect.stringMatching(/No tool picked for linear/)]);
  });

  test("the badge: inherit, or what is restricted with names and accounts", () => {
    expect(describeToolScope(undefined, CONNECTORS)).toBe("Inherit from agent");
    expect(describeToolScope({ connectors: ["linear", "gmail-2"], connectorTools: { linear: ["a", "b", "c"] } }, CONNECTORS))
      .toBe("Restricted: Linear (3 tools), Gmail 2 – info@acme.com");
    expect(describeToolScope({ connectors: "none", allowedTools: [] }, CONNECTORS)).toBe("Restricted: no connectors; built-in: none");
  });
});

// ── The card and its editor ─────────────────────────────────────────────────
let root: Root;
let host: HTMLDivElement;

function installFetch() {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const reply = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }));
    if (url.pathname === "/api/v1/connectors") return reply({ connectors: CONNECTORS });
    if (url.pathname === "/api/v1/connectors/linear/tools") {
      return reply({ tools: [
        { name: "create_issue", title: "Create issue", policy: "allow" },
        { name: "list_issues", policy: "allow" },
        { name: "delete_issue", policy: "off" },
      ] });
    }
    throw new Error(`unexpected ${url.pathname}`);
  }) as typeof fetch;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  installFetch();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | null;

test("the card shows Inherit by default and the stale entries; the editor restricts to what the agent has", async () => {
  const onSave = vi.fn(async () => undefined);
  await act(async () => {
    root.render(<TaskToolScopeCard scope={undefined} stale={['connectors: agent "pm" has no access to Notion (notion)']} agent={{ name: "pm" }} onSave={onSave} />);
  });
  await flush();
  expect(host.querySelector('[data-testid="task-tool-scope-badge"]')!.textContent).toBe("Inherit from agent");
  expect(host.querySelector('[data-testid="task-tool-scope-stale"]')!.textContent).toMatch(/no access to Notion/);

  click([...host.querySelectorAll("button")].find((b) => b.textContent === "Restrict"));
  const dialog = document.querySelector('[data-testid="task-tool-scope-dialog"]')!;
  expect(dialog).toBeTruthy();
  // switch to Restrict: starts from every connector the agent has (not Notion, not the disabled one)
  click(byLabel("Restrict"));
  expect([...dialog.querySelectorAll('[data-testid^="task-tool-scope-connector-"]')].map((el) => el.getAttribute("data-testid")))
    .toEqual(["task-tool-scope-connector-linear", "task-tool-scope-connector-gmail", "task-tool-scope-connector-gmail-2"]);
  expect(dialog.textContent).toContain("Gmail 2 – info@acme.com");
  // leave Gmail out, and only one Linear tool (turned-off tools are not offered)
  click(byLabel("Use Gmail"));
  click(byLabel("Only selected"));
  await flush();
  const linear = dialog.querySelector('[data-testid="task-tool-scope-connector-linear"]')!;
  expect(linear.textContent).toContain("Create issue");
  expect(linear.textContent).not.toContain("delete_issue");
  click([...linear.querySelectorAll("button")].find((b) => b.textContent === "Select none"));
  click(byLabel("Create issue"));
  // only some built-in tools
  click(byLabel("Only some built-in tools"));
  click(byLabel("bash"));
  click([...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save"));
  await flush();
  expect(onSave).toHaveBeenCalledTimes(1);
  const saved = (onSave.mock.calls[0] as unknown as [TaskToolScope])[0];
  expect(saved.connectors).toEqual(["linear", "gmail-2"]);
  expect(saved.connectorTools).toEqual({ linear: ["create_issue"] });
  expect(saved.allowedTools).not.toContain("bash");
  expect(saved.allowedTools).toContain("read");
});

test("Inherit from agent saves null (clears the scope)", async () => {
  const onSave = vi.fn(async () => undefined);
  await act(async () => {
    root.render(<TaskToolScopeCard scope={{ connectors: ["linear"] }} agent={{ name: "pm" }} onSave={onSave} />);
  });
  await flush();
  expect(host.querySelector('[data-testid="task-tool-scope-badge"]')!.textContent).toBe("Restricted: Linear");
  click([...host.querySelectorAll("button")].find((b) => b.textContent === "Edit"));
  click(byLabel("Inherit from agent"));
  click([...document.querySelectorAll('[data-testid="task-tool-scope-dialog"] button')].find((b) => b.textContent?.trim() === "Save"));
  await flush();
  expect(onSave).toHaveBeenCalledWith(null);
});
