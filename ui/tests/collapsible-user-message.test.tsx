import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CollapsibleUserMessage, USER_MESSAGE_MAX_HEIGHT } from "../src/components/shared/collapsible-user-message";

let root: Root;
let container: HTMLDivElement;
let height = 0;
let onResize: () => void;
const disconnect = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { onResize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  height = 0;
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); disconnect.mockClear();
});
async function render(text = "Complete user message", key = "first") {
  await act(async () => root.render(<CollapsibleUserMessage key={key} text={text}>{text}</CollapsibleUserMessage>));
}

test("short messages have no expansion control", async () => {
  height = USER_MESSAGE_MAX_HEIGHT;
  await render();
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toBe("Complete user message");
});
test("long messages collapse, expand and collapse without changing the text", async () => {
  height = 1000; const text = "Message line\n".repeat(100);
  await render(text);
  const button = container.querySelector("button")!;
  const region = document.getElementById(button.getAttribute("aria-controls")!)!;
  expect(button.textContent).toBe("Mostra tutto");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(region.style.maxHeight).toBe("240px"); expect(region.textContent).toBe(text);
  await act(async () => button.click());
  expect(button.textContent).toBe("Riduci"); expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(region.style.maxHeight).toBe(""); expect(region.textContent).toBe(text);
  await act(async () => button.click()); expect(region.style.maxHeight).toBe("240px");
});
test("wrapping changes update overflow without using character-count guesses", async () => {
  height = 100; await render();
  expect(container.querySelector("button")).toBeNull();
  height = 300; await act(async () => onResize());
  expect(container.querySelector("button")).not.toBeNull();
  height = 80; await act(async () => onResize());
  expect(container.querySelector("button")).toBeNull();
});
test("expansion does not leak to another message and observers are cleaned up", async () => {
  height = 1000; await render();
  await act(async () => container.querySelector("button")!.click());
  await render("Second message", "second");
  expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  expect(disconnect).toHaveBeenCalled();
});
