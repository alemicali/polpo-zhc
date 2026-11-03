import { describe, expect, test } from "vitest";
import type { Node } from "@xyflow/react";
import { withMeasured } from "@/lib/graph-nodes";

describe("rebuilt graph nodes", () => {
  const rebuilt: Node = { id: "task-0", position: { x: 0, y: 0 }, data: {} };

  test("keep the size React Flow measured, so they are not hidden until measured again", () => {
    const shown: Node = { ...rebuilt, measured: { width: 240, height: 120 } };
    expect(withMeasured(rebuilt, shown).measured).toEqual({ width: 240, height: 120 });
  });

  test("a new node, or one that already has a size, is left as is", () => {
    expect(withMeasured(rebuilt, undefined)).toBe(rebuilt);
    const sized: Node = { ...rebuilt, measured: { width: 10, height: 10 } };
    expect(withMeasured(sized, { ...rebuilt, measured: { width: 240, height: 120 } })).toBe(sized);
  });
});
