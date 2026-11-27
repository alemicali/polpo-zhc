/**
 * The MCP computer card (widgets/computer-card/view.ts) rendered in a DOM from the server's card
 * (src/server/mcp-computer-card.ts): the live view, who holds the desktop, the agents waiting for a
 * person, Take control / Give back with a note, the link to the live view; the text form.
 */
import { describe, expect, it, vi } from "vitest";
import { renderView } from "../../widgets/computer-card/view";
import { buildComputerCard, computerCardText } from "../../src/server/mcp-computer-card";

const key = { createdAt: 1, seq: 1 };
const request = {
  id: "tko_1", agent: "sitoinchat", reason: "LinkedIn asks for a 2FA code", url: "https://linkedin.com/checkpoint", whatToDo: "Sign in",
  status: "pending", createdAt: "2026-11-26T10:00:00Z", expiresAt: "2026-11-26T10:30:00Z",
};
const env = (card: unknown, extra: Record<string, unknown> = {}) => ({ card: card as never, locale: "en", full: false, canFullscreen: true, busy: false, superseded: false, ...extra });

describe("the computer card (MCP App)", () => {
  it("an agent waiting: the request, Take control, the live view link", () => {
    const card = buildComputerCard({
      computer: { id: "nina", name: "Nina", kind: "daytona", status: "running" }, desktop: { state: "running" },
      control: { holder: "agent", requests: [request, { ...request, id: "tko_0", status: "released", note: "done" }] }, key, link: "https://polpo.test/computers/nina?live=1",
    });
    const root = document.createElement("div");
    const onTake = vi.fn();
    const onLink = vi.fn();
    renderView(root, env(card, { onTake, onLink }));
    expect(root.querySelector('[data-request="tko_1"]')!.textContent).toMatch(/sitoinchat: LinkedIn asks for a 2FA code.*Page: https:\/\/linkedin.com\/checkpoint.*To do: Sign in/);
    // the closed one only full screen
    expect(root.querySelector('[data-request="tko_0"]')).toBeNull();
    (root.querySelector('[data-action="take"]') as HTMLButtonElement).click();
    expect(onTake).toHaveBeenCalled();
    [...root.querySelectorAll("button")].find((b) => b.textContent === "Open the live view")!.click();
    expect(onLink).toHaveBeenCalledWith("https://polpo.test/computers/nina?live=1");
    expect(computerCardText(card)).toMatch(/Waiting for a person:\n- sitoinchat: LinkedIn asks for a 2FA code/);
  });

  it("a person holding it: Give back with a note; Italian strings", () => {
    const card = buildComputerCard({
      computer: { id: "nina", name: "Nina", kind: "daytona", status: "running" }, desktop: { state: "running" },
      control: { holder: "person", person: "ale@x.it", since: "2026-11-26T10:01:00Z", requests: [{ ...request, status: "in_control", takenBy: "ale@x.it" }] }, key,
    });
    const root = document.createElement("div");
    const onGive = vi.fn();
    renderView(root, env(card, { onGive, locale: "it" }));
    expect(root.querySelector('[data-holder="person"]')!.textContent).toMatch(/ale@x.it ha il controllo/);
    const note = root.querySelector("input")! as HTMLInputElement;
    note.value = "Fatto";
    (root.querySelector('[data-action="give"]') as HTMLButtonElement).click();
    expect(onGive).toHaveBeenCalledWith("Fatto");
    expect(computerCardText(card)).toMatch(/ale@x.it has control/);
  });
});
