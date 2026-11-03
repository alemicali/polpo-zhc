import { describe, expect, test } from "vitest";
import type { LoopConfig, Pipeline } from "@polpo-ai/react";
import {
  addCase,
  deleteLoop,
  getAt,
  insertStep,
  moveStep,
  newStep,
  NO_LOOP_WARNING,
  parsePathKey,
  pipelineWarnings,
  pathKey,
  removeCase,
  removeStep,
  renameLoop,
  setDefaultBranch,
  updateCaseWhen,
  updateStep,
  validatePipeline,
} from "@/lib/pipeline-edit";
import { layoutPipeline } from "@/lib/pipeline-layout";

const loops: Record<string, LoopConfig> = { triage: {}, resolve: {}, refund: {} };

function support(): Pipeline {
  return {
    steps: [
      { loop: "triage" },
      {
        switch: {
          cases: [{ when: "context.ticket.category == 'billing'", steps: [{ human: "refund_ok" }, { loop: "refund" }] }],
          default: { steps: [{ loop: "resolve" }] },
        },
      },
    ],
  };
}

describe("pipeline editing", () => {
  test("paths round-trip through keys", () => {
    const path = ["steps", 1, "switch", "cases", 0, "steps", 1];
    expect(parsePathKey(pathKey(path))).toEqual(path);
    expect(getAt(support(), path)).toEqual({ loop: "refund" });
  });

  test("insert, move, update and remove steps without mutating the input", () => {
    const p = support();
    let next = insertStep(p, ["steps", 1, "switch", "cases", 0, "steps"], 0, { loop: "triage" });
    expect(getAt(next, ["steps", 1, "switch", "cases", 0, "steps"])).toHaveLength(3);
    expect(getAt(p, ["steps", 1, "switch", "cases", 0, "steps"])).toHaveLength(2);

    next = moveStep(next, ["steps", 1, "switch", "cases", 0, "steps", 0], 1);
    expect(getAt(next, ["steps", 1, "switch", "cases", 0, "steps", 1])).toEqual({ loop: "triage" });

    next = updateStep(next, ["steps", 0], { when: "context.go == true" });
    expect(next.steps[0]).toEqual({ loop: "triage", when: "context.go == true" });
    next = updateStep(next, ["steps", 0], { when: undefined });
    expect(next.steps[0]).toEqual({ loop: "triage" });

    next = removeStep(next, ["steps", 1]);
    expect(next.steps).toEqual([{ loop: "triage" }]);
  });

  test("switch cases and default branch", () => {
    let p = addCase(support(), ["steps", 1]);
    p = updateCaseWhen(p, ["steps", 1], 1, "context.x > 1");
    expect(getAt(p, ["steps", 1, "switch", "cases", 1])).toEqual({ when: "context.x > 1", steps: [] });
    p = removeCase(p, ["steps", 1], 0);
    p = setDefaultBranch(p, ["steps", 1], false);
    expect(p.steps[1]).toEqual({ switch: { cases: [{ when: "context.x > 1", steps: [] }] } });
  });

  test("renaming a loop updates every step; deleting a used loop is refused", () => {
    const renamed = renameLoop(loops, support(), "refund", "issue_refund");
    expect(Object.keys(renamed.loops!)).toEqual(["triage", "resolve", "issue_refund"]);
    expect(getAt(renamed.pipeline, ["steps", 1, "switch", "cases", 0, "steps", 1])).toEqual({ loop: "issue_refund" });
    expect(renameLoop(loops, support(), "refund", "triage").error).toMatch(/already exists/);
    expect(deleteLoop(loops, support(), "refund").error).toMatch(/used by 1 step/);
    expect(Object.keys(deleteLoop({ ...loops, spare: {} }, support(), "spare").loops!)).toEqual(["triage", "resolve", "refund"]);
  });

  test("validation finds what the server or runtime would reject", () => {
    expect(validatePipeline(support(), loops)).toEqual([]);
    const bad: Pipeline = {
      steps: [
        { loop: "missing" },
        newStep("parallel", loops),
        { parallel: [{ loop: "triage" }], join: 3 },
        { switch: { cases: [{ when: "", steps: [] }] } },
        { human: "", when: " " },
      ],
    };
    const messages = validatePipeline(bad, { triage: { maxTurns: 0 } }).map((p) => p.message);
    expect(messages).toEqual([
      'Unknown loop "missing".',
      "Add at least one branch.",
      "Join waits for 3 branches but there are 1.",
      "Case 1 has no condition.",
      "Case 1 has no steps.",
      "The guard (when) is empty.",
      "The human step needs a name.",
      'Loop "triage": max turns must be a positive whole number.',
    ]);
    expect(validatePipeline({ steps: [] }, {})[0].message).toBe("The pipeline has no steps.");
    const twins = validatePipeline({ steps: [{ parallel: [{ human: "ok" }, { human: "ok" }] }] }, {});
    expect(newStep("human", {}, { steps: [{ human: "approval" }, { human: "approval-2" }] })).toEqual({ human: "approval-3" });
    expect(twins.map((p) => p.message)).toEqual(['Another human step is also named "ok".', 'Another human step is also named "ok".']);
  });

  test("a pipeline with no loop step is saved with a warning: it never runs the agent", () => {
    expect(pipelineWarnings({ steps: [{ human: "approval" }] })).toEqual([NO_LOOP_WARNING]);
    expect(pipelineWarnings({ steps: [{ parallel: [{ human: "a" }, { human: "b" }] }] })).toEqual([NO_LOOP_WARNING]);
    // Not a problem: it saves.
    expect(validatePipeline({ steps: [{ human: "approval" }] }, {})).toEqual([]);

    expect(pipelineWarnings(support())).toEqual([]);
    expect(pipelineWarnings({ steps: [{ switch: { cases: [{ when: "x", steps: [{ loop: "triage" }] }] } }, { human: "ok" }] })).toEqual([]);
    // An empty pipeline is already a problem.
    expect(pipelineWarnings({ steps: [] })).toEqual([]);
  });
});

describe("pipeline layout", () => {
  test("lays out steps, a switch with its columns, and insertion slots", () => {
    const { nodes, edges } = layoutPipeline(support());
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain("start");
    expect(ids).toContain("end");
    expect(ids).toContain("step:steps.0");
    expect(ids).toContain("step:steps.1");
    expect(ids).toContain("merge:steps.1");
    expect(ids).toContain("step:steps.1.switch.cases.0.steps.1");
    expect(ids).toContain("step:steps.1.switch.default.steps.0");

    // Every node id is unique and every edge points at existing nodes.
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of edges) {
      expect(ids).toContain(e.source);
      expect(ids).toContain(e.target);
    }

    // Insertion slots: before the first step, between steps, at the end of the root list.
    const slots = edges.flatMap((e) => (e.data?.slot ? [`${pathKey(e.data.slot.listPath)}@${e.data.slot.index}`] : []));
    expect(slots).toEqual(expect.arrayContaining(["steps@0", "steps@1", "steps@2", "steps.1.switch.cases.0.steps@0", "steps.1.switch.cases.0.steps@1", "steps.1.switch.cases.0.steps@2"]));

    // Case labels are on the edges leaving the switch.
    expect(edges.find((e) => e.source === "step:steps.1" && e.data?.label === "default")).toBeDefined();

    // Top to bottom: start above the switch, switch above its merge, merge above end.
    const y = (id: string) => nodes.find((n) => n.id === id)!.position.y;
    expect(y("start")).toBeLessThan(y("step:steps.1"));
    expect(y("step:steps.1")).toBeLessThan(y("merge:steps.1"));
    expect(y("merge:steps.1")).toBeLessThan(y("end"));
  });

  test("empty pipelines and empty branches still have somewhere to insert", () => {
    const empty = layoutPipeline({ steps: [] });
    expect(empty.edges).toHaveLength(1);
    expect(empty.edges[0].data?.slot).toEqual({ listPath: ["steps"], index: 0 });

    const p = layoutPipeline({ steps: [{ parallel: [], join: "all" }, { switch: { cases: [{ when: "x", steps: [] }] } }] });
    const ids = p.nodes.map((n) => n.id);
    expect(ids).toContain("empty:steps.0.parallel");
    expect(ids).toContain("empty:steps.1.switch.cases.0.steps");
  });
});
