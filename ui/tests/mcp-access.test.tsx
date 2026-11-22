import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

afterEach(cleanup);

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const api = vi.hoisted(() => ({ access: null as unknown, revoked: [] as string[] }));
vi.mock("@/lib/mcp-access-api", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/mcp-access-api")>();
  return {
    ...actual,
    mcpAccessApi: {
      get: async () => api.access,
      revokeGrant: async (id: string) => {
        api.revoked.push(id);
        const a = api.access as import("../src/lib/mcp-access-api").McpAccess;
        api.access = { ...a, grants: a.grants.filter((g) => g.id !== id) };
        return { revoked: id };
      },
    },
  };
});

import { McpAccessSection } from "../src/components/config/mcp-access-section";
import { visibleScopes, type McpAccess } from "../src/lib/mcp-access-api";

const scopes = [
  { id: "polpo:read", label: "Read", description: "See things" },
  { id: "polpo:work", label: "Work", description: "Do the work" },
  { id: "polpo:files", label: "Files", description: "Write files" },
  { id: "polpo:admin", label: "Admin", description: "Change the instance" },
];
const access = (): McpAccess => ({
  scopes,
  tools: [{ name: "polpo_file_write", toolset: "files", scope: "polpo:files", destructive: true }],
  grants: [
    { id: "g1", client_id: "c1", client_name: "Claude", subject: "ada@example.com", scopes: ["polpo:read", "polpo:work", "polpo:files"], legacy: false,
      created_at: "2026-11-20T10:00:00.000Z", last_used_at: "2026-11-21T09:00:00.000Z", expires_at: "2026-12-20T10:00:00.000Z" },
    { id: "g2", client_id: "c2", client_name: "ChatGPT", subject: "api-key", scopes: ["polpo:read", "polpo:work", "polpo:files", "polpo:admin"], legacy: true,
      created_at: "2026-10-01T10:00:00.000Z", expires_at: "2026-12-01T10:00:00.000Z" },
  ],
  keys: [
    { name: "POLPO_MCP_KEY", source: "env", scopes: ["polpo:read", "polpo:work", "polpo:files", "polpo:admin"], explicit: false },
    { name: "ci", source: "settings", scopes: ["polpo:read"], explicit: true, ref: "ops / mcp-ci" },
  ],
});

describe("Settings → MCP access", () => {
  test("admin alone stands for every scope", () => {
    expect(visibleScopes(["polpo:read", "polpo:admin"])).toEqual(["polpo:admin"]);
    expect(visibleScopes(["polpo:read", "polpo:work"])).toEqual(["polpo:read", "polpo:work"]);
  });

  test("lists connected apps with who allowed them, their scopes and dates, and flags the legacy ones", async () => {
    api.access = access();
    render(<McpAccessSection />);
    const claude = await screen.findByTestId("mcp-grant-g1");
    expect(within(claude).getByText("Claude")).toBeTruthy();
    expect(within(claude).getByText(/allowed by ada@example.com/)).toBeTruthy();
    for (const label of ["Read", "Work", "Files"]) expect(within(claude).getByText(label)).toBeTruthy();
    expect(within(claude).queryByText(/Connected before scopes/)).toBeNull();
    expect(within(claude).getByText(/last used/).textContent).not.toMatch(/never/);

    const chatgpt = screen.getByTestId("mcp-grant-g2");
    expect(within(chatgpt).getByText(/an API or MCP key/)).toBeTruthy();
    expect(within(chatgpt).getByText("Admin")).toBeTruthy();
    expect(within(chatgpt).queryByText("Work")).toBeNull();
    expect(within(chatgpt).getByText(/Connected before scopes/)).toBeTruthy();
    expect(within(chatgpt).getByText(/last used never/)).toBeTruthy();
  });

  test("lists keys by name with their scopes, warns about the unnarrowed legacy key", async () => {
    api.access = access();
    render(<McpAccessSection />);
    const keys = await screen.findByTestId("mcp-keys");
    expect(within(keys).getByText("POLPO_MCP_KEY")).toBeTruthy();
    expect(within(keys).getByText(/Set POLPO_MCP_KEY_SCOPES/)).toBeTruthy();
    expect(within(keys).getByText("ci")).toBeTruthy();
    expect(within(keys).getByText(/vault ops \/ mcp-ci/)).toBeTruthy();
  });

  test("revokes a grant after confirming", async () => {
    api.access = access();
    api.revoked = [];
    render(<McpAccessSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Claude" }));
    expect(api.revoked).toEqual([]);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(api.revoked).toEqual(["g1"]));
    await waitFor(() => expect(screen.queryByTestId("mcp-grant-g1")).toBeNull());
    expect(screen.getByTestId("mcp-grant-g2")).toBeTruthy();
  });

  test("says when no app is connected", async () => {
    api.access = { ...access(), grants: [], keys: [] };
    render(<McpAccessSection />);
    expect(await screen.findByText("No app is connected.")).toBeTruthy();
    expect(screen.getByText(/No key/)).toBeTruthy();
  });
});
