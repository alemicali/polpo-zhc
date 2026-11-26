/**
 * The MCP coding card (widgets/coding-card/view.ts) rendered in a DOM from the server's card
 * (src/server/mcp-coding-card.ts): a coding chat's latest messages, one line per tool call (edits
 * with their +/− lines), the approval waiting with Approve / Deny, and the text other clients get.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/coding-card/view";
import { buildCodingCard, codingCardText, type CodingSessionShape } from "../../src/server/mcp-coding-card";

const key = { createdAt: 1, seq: 1 };
const session: CodingSessionShape = {
  id: "cc_abc12345", title: "Fix tests", kind: "claude", status: "awaiting-approval", cwd: "/work/wt/lisbon", branch: "lisbon", model: "claude-opus-4-5",
  turns: 1, usage: { totalTokens: 1234 }, costUsd: 0.05,
  messages: [
    { id: "m1", role: "user", ts: "2026-11-26T10:00:00Z", text: "Fix the tests and push" },
    { id: "m2", role: "assistant", ts: "2026-11-26T10:00:05Z", streaming: true, segments: [
      { type: "tool", tool: { id: "t1", name: "Edit", input: { file_path: "src/a.ts" }, diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-const b = 2;\n+const b = 3;\n+const c = 4;", state: "completed" } },
      { type: "tool", tool: { id: "t2", name: "Bash", input: { command: "pnpm test" }, state: "completed" } },
      { type: "text", text: "Tests pass; pushing." },
      { type: "approval", approvalId: "ap_1" },
    ] },
  ],
  approvals: [{ id: "ap_1", summary: "$ git push origin lisbon", reason: "Pushes to a remote", category: "git-push", state: "pending" }],
};
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });

describe("the coding card (MCP App)", () => {
  it("the transcript: messages, tool lines with +/− lines, status and the approval waiting", () => {
    const root = document.createElement("div");
    const onDecide = vi.fn();
    const card = buildCodingCard({ session, key });
    renderView(root, env(card, { onDecide }));
    expect(root.querySelector("[data-status]")!.textContent).toBe("Needs approval");
    expect(root.textContent).toContain("Fix the tests and push");
    const edit = root.querySelector('[data-tool="Edit"]')!;
    expect(edit.textContent).toContain("Edited src/a.ts");
    expect(edit.querySelector(".add")!.textContent).toBe("+2");
    expect(edit.querySelector(".del")!.textContent).toBe("−1");
    expect(root.querySelector('[data-tool="Bash"]')!.textContent).toContain("Ran pnpm test");
    const approval = root.querySelector('[data-approval="ap_1"]')!;
    expect(approval.textContent).toContain("$ git push origin lisbon");
    (approval.querySelector(".btn-primary") as HTMLButtonElement).click();
    expect(onDecide).toHaveBeenCalledWith("ap_1", "approve");
    const text = codingCardText(card);
    expect(text).toContain("Edited src/a.ts (+2 −1)");
    expect(text).toContain("WAITING FOR APPROVAL ap_1: $ git push origin lisbon — Pushes to a remote");
  });

  it("older messages are counted; Italian strings", () => {
    const root = document.createElement("div");
    const many = { ...session, status: "idle", approvals: [], messages: Array.from({ length: 15 }, (_, i) => ({ id: `m${i}`, role: "user" as const, ts: "2026-11-26T10:00:00Z", text: `msg ${i}` })) };
    renderView(root, env(buildCodingCard({ session: many, key }), { locale: "it" }));
    expect(root.textContent).toContain("3 messaggi precedenti");
    expect(root.querySelector("[data-status]")!.textContent).toBe("In attesa");
  });
});
