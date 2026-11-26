/**
 * The MCP trigger card (widgets/trigger-card/view.ts) rendered in a DOM from the server's cards
 * (src/server/mcp-trigger-card.ts): the list with endpoints, auth, counts and warnings; one trigger
 * with its deliveries, the status filter, the last mapped values, and the actions.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/trigger-card/view";
import { buildTriggerDetailCard, buildTriggerListCard, triggerCardText, type TriggerShape } from "../../src/server/mcp-trigger-card";

const key = { createdAt: 1, seq: 1 };
const trigger: TriggerShape = {
  id: "signup-3f9a1c2e", name: "Signup form", enabled: true, endpoint: "https://host.ts.net/acme/hooks/signup-3f9a1c2e",
  auth: { secret: true, hmac: { algorithm: "sha256" } }, hmacSecret: { secretSet: false },
  contractVersion: 3, contract: { contentTypes: ["json", "form"] },
  filter: { mode: "all", conditions: [{ path: "body.event", op: "equals", value: "submitted" }] },
  dedupe: { key: "{{body.id}}", ttlSeconds: 600 }, rateLimitPerMinute: 60, mapping: { email: "{{body.email}}" },
  stats: { counts: { accepted: 4, rejected: 1, filtered: 2 }, total: 7, lastDeliveryAt: "2026-11-26T10:00:00Z", lastStatus: "accepted" },
};
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });

describe("the trigger card (MCP App)", () => {
  it("lists triggers with their endpoint, auth, counts and a missing HMAC secret; a trigger opens", () => {
    const root = document.createElement("div");
    const onShow = vi.fn();
    const card = buildTriggerListCard({ triggers: [trigger, { ...trigger, id: "off-00000000", name: "Old hook", enabled: false, auth: { secret: true }, hmacSecret: undefined, stats: { counts: {}, total: 0 } }], key });
    renderView(root, env(card, { onShow }));
    const row = root.querySelector('[data-trigger="signup-3f9a1c2e"]')!;
    expect(row.textContent).toContain("https://host.ts.net/acme/hooks/signup-3f9a1c2e");
    expect(row.textContent).toContain("secret + HMAC sha256");
    expect(row.textContent).toContain("4 accepted · 1 rejected · 2 filtered");
    expect(row.textContent).toContain("The HMAC signing secret is not set");
    expect(root.querySelector('[data-trigger="off-00000000"]')!.textContent).toContain("Disabled");
    expect(root.textContent).toContain("No actions run on deliveries yet");
    (row.querySelector(".link-btn") as HTMLButtonElement).click();
    expect(onShow).toHaveBeenCalledWith({ id: "signup-3f9a1c2e" });
    expect(triggerCardText(card)).toContain("Signup form [signup-3f9a1c2e]");
  });

  it("one trigger: its rules in words, deliveries with reasons and errors, the status filter, the last mapped values", () => {
    const root = document.createElement("div");
    const onShow = vi.fn();
    const card = buildTriggerDetailCard({
      trigger, key,
      deliveries: [
        { id: "tdl_2", receivedAt: "2026-11-26T10:00:00Z", status: "rejected", httpStatus: 400, reasons: ["The body does not match the contract (v3): 1 error"], errors: ["body.email: required"], bytes: 12 },
        { id: "tdl_1", receivedAt: "2026-11-26T09:00:00Z", status: "accepted", httpStatus: 202, reasons: [], bytes: 40, test: true },
      ],
      lastMapped: { email: "ada@example.com" },
    });
    renderView(root, env(card, { onShow, statuses: ["rejected"] }));
    expect(root.textContent).toContain("all of: body.event equals \"submitted\"");
    expect(root.textContent).toContain("{{body.id}} · 600s");
    expect(root.querySelector('[data-delivery="tdl_2"]')!.textContent).toContain("body.email: required");
    expect(root.querySelector('[data-delivery="tdl_1"] [data-status="accepted"]')).not.toBeNull();
    expect(root.querySelector(".mapped")!.textContent).toContain("ada@example.com");
    expect(root.querySelector('[data-filter="rejected"]')!.className).toContain("on");
    (root.querySelector('[data-filter="filtered"]') as HTMLButtonElement).click();
    expect(onShow).toHaveBeenCalledWith({ id: "signup-3f9a1c2e", status: ["rejected", "filtered"] });
    const back = [...root.querySelectorAll("button")].find((b) => b.textContent === "All triggers")!;
    back.click();
    expect(onShow).toHaveBeenLastCalledWith({});
    expect(triggerCardText(card)).toContain("last mapped values: {\"email\":\"ada@example.com\"}");
  });

  it("speaks Italian when the host does", () => {
    const root = document.createElement("div");
    renderView(root, env(buildTriggerListCard({ triggers: [], key }), { locale: "it-IT" }));
    expect(root.textContent).toContain("Ancora nessun trigger");
  });
});
