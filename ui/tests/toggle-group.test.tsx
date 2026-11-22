import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SegmentedControl, ToggleGroupItem } from "../src/components/ui/toggle-group";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type Range = "today" | "7d" | "30d";

function Harness({ onChange, disabled }: { onChange: (v: Range) => void; disabled?: boolean }) {
  const [value, setValue] = useState<Range>("7d");
  return (
    <SegmentedControl
      size="sm"
      aria-label="Period"
      value={value}
      disabled={disabled}
      onValueChange={(v) => { setValue(v); onChange(v); }}
    >
      <ToggleGroupItem value="today">Today</ToggleGroupItem>
      <ToggleGroupItem value="7d">7d</ToggleGroupItem>
      <ToggleGroupItem value="30d">30d</ToggleGroupItem>
    </SegmentedControl>
  );
}

const item = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label)!;

test("SegmentedControl: radio semantics, shared track and active styling", async () => {
  await act(async () => root.render(<Harness onChange={() => {}} />));
  const group = container.querySelector('[role="radiogroup"][aria-label="Period"]')!;
  expect(group).toBeTruthy();
  expect(group.getAttribute("data-slot")).toBe("toggle-group");
  expect(group.className).toContain("bg-muted");
  expect(group.className).toContain("h-8");
  expect(item("7d").getAttribute("aria-checked")).toBe("true");
  expect(item("7d").getAttribute("data-state")).toBe("on");
  expect(item("7d").className).toContain("data-[state=on]:bg-background");
  expect(item("7d").className).toContain("data-[state=on]:shadow-card");
  expect(item("7d").className).toContain("text-small");
  expect(item("Today").getAttribute("aria-checked")).toBe("false");
});

test("SegmentedControl: selects another value, never empties on re-click", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<Harness onChange={onChange} />));
  await act(async () => item("30d").click());
  expect(onChange).toHaveBeenLastCalledWith("30d");
  expect(item("30d").getAttribute("aria-checked")).toBe("true");
  await act(async () => item("30d").click());
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(item("30d").getAttribute("aria-checked")).toBe("true");
});

test("SegmentedControl: disabled blocks changes", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<Harness onChange={onChange} disabled />));
  expect(item("Today").disabled).toBe(true);
  await act(async () => item("Today").click());
  expect(onChange).not.toHaveBeenCalled();
});
