import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ComputerTakeoverRequest } from "@polpo-ai/react";
import { TakeoverRequestBanner } from "../src/components/computers/computer-live-panel";
import { takeoverTimeLeft } from "../src/lib/takeover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const base: ComputerTakeoverRequest = {
  id: "tko_1", computerId: "ms-nina-01", agent: "nina", reason: "TikTok asks for an SMS code", createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 14 * 60_000 + 30_000).toISOString(), status: "pending",
};

test("the countdown text", () => {
  const now = Date.parse("2026-11-28T10:00:00Z");
  expect(takeoverTimeLeft("2026-11-28T10:12:00Z", now)).toBe("12 min left");
  expect(takeoverTimeLeft("2026-11-28T11:05:00Z", now)).toBe("1 h 5 min left");
  expect(takeoverTimeLeft("2026-11-28T09:59:00Z", now)).toBe("time is up");
});

test("the takeover card shows the level, the countdown and what happens then; a parked request says the task is paused", () => {
  act(() => root.render(<TakeoverRequestBanner requests={[
    { ...base, level: "hard", taskId: "t1" },
    { ...base, id: "tko_2", reason: "Check the draft" },
    { ...base, id: "tko_3", level: "hard", taskId: "t2", parkedAt: new Date().toISOString() },
  ]} />));
  const [hard, soft, parked] = [...host.querySelectorAll("[data-request]")];
  expect(hard!.getAttribute("data-level")).toBe("hard");
  expect(hard!.querySelector("[data-testid=takeover-level]")!.textContent).toBe("Blocking");
  expect(hard!.querySelector("[data-testid=takeover-countdown]")!.textContent).toMatch(/15 min left\), then its task pauses until you do it/);
  expect(soft!.querySelector("[data-testid=takeover-level]")!.textContent).toBe("Optional");
  expect(soft!.querySelector("[data-testid=takeover-countdown]")!.textContent).toMatch(/then the agent goes on without it/);
  expect(parked!.querySelector("[data-testid=takeover-parked]")!.textContent).toMatch(/its task is paused until you take control/);
  expect(parked!.querySelector("[data-testid=takeover-countdown]")).toBeNull();
});
