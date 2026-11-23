import { describe, expect, test } from "vitest";
import { budgetText, missionRequestOf } from "@/lib/mission-preview";

describe("mission preview → create request", () => {
  test("keeps the proposed budget", () => {
    expect(missionRequestOf({ name: "Launch", prompt: "plan the launch", budgetUsd: 25 }, "{\"tasks\":[]}")).toEqual({
      data: "{\"tasks\":[]}", name: "Launch", prompt: "plan the launch", status: "draft", budgetUsd: 25,
    });
  });

  test("no budget, or an invalid one: none sent", () => {
    expect(missionRequestOf({ name: "Launch" }, "{}")).toEqual({ data: "{}", name: "Launch", status: "draft" });
    expect(missionRequestOf({ name: "Launch", budgetUsd: 0 }, "{}")).not.toHaveProperty("budgetUsd");
    expect(missionRequestOf({ name: "Launch", budgetUsd: Number.NaN }, "{}")).not.toHaveProperty("budgetUsd");
  });

  test("budget text", () => {
    expect(budgetText(25)).toBe("$25");
    expect(budgetText(12.5)).toBe("$12.50");
  });
});
