import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { VaultProvenanceBadge } from "../src/components/agents/agent-credentials-tab";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
});

const badge = () => container.querySelector("[data-testid=vault-provenance]")!;

describe("vault entry provenance badge", () => {
  test("an entry an agent created: its name, the date, the task in the tooltip", async () => {
    await act(async () => root.render(<VaultProvenanceBadge entry={{
      createdBy: { kind: "agent", agent: "ada", taskId: "t1" }, createdAt: "2026-11-27T10:00:00.000Z", rotatedAt: "2026-11-28T10:00:00.000Z",
    }} />));
    expect(badge().textContent).toMatch(/^Created by ada · .*2026/);
    expect(badge().getAttribute("title")).toContain('Created by agent "ada" in task t1');
    expect(badge().getAttribute("title")).toContain("password rotated");
  });

  test("a person's entry, and an entry without provenance, read as added by a person", async () => {
    await act(async () => root.render(<VaultProvenanceBadge entry={{ createdBy: { kind: "person", by: "ops@acme.com" }, createdAt: "2026-11-27T10:00:00.000Z" }} />));
    expect(badge().textContent).toMatch(/^Added by a person · /);
    expect(badge().getAttribute("title")).toContain("ops@acme.com");
    await act(async () => root.render(<VaultProvenanceBadge entry={{}} />));
    expect(badge().textContent).toBe("Added by a person");
  });
});
