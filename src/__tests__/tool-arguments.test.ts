import { describe, expect, it } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { checkToolCalls } from "@polpo-ai/server";
import { ALL_ORCHESTRATOR_TOOLS } from "../llm/orchestrator-tools.js";

const tasks = [{ title: "Raccogli dati", description: "Scrivi dati.md", assignTo: "agent-1" }];
const call = (args: Record<string, unknown>, name = "create_mission") => ({ id: "c1", name, arguments: args });
const check = (calls: ReturnType<typeof call>[]) => checkToolCalls(ALL_ORCHESTRATOR_TOOLS as any, calls, validateToolArguments as any);

describe("checkToolCalls (create_mission, as local models call it)", () => {
  it("accepts the mission data as an object", () => {
    expect(check([call({ name: "report-meteo", data: { tasks } })]).size).toBe(0);
  });

  it("accepts the mission data as a JSON string, and passes it on parsed", () => {
    const c = call({ name: "report-meteo", data: JSON.stringify({ tasks }) });
    expect(check([c]).size).toBe(0);
    expect(c.arguments.data).toEqual({ tasks });
  });

  it("refuses the mission name put inside data, with a reason the model can act on", () => {
    const invalid = check([call({ data: { name: "report-meteo", tasks }, status: "draft" })]);
    const result = invalid.get("c1")!;
    expect(result).toMatch(/^Error: the arguments of create_mission do not match its parameters/);
    expect(result).toContain("name");
    expect(result).not.toContain("Received arguments");
  });

  it("leaves unknown tools to the executor, and checks nothing without a validator", () => {
    expect(check([call({ anything: 1 }, "no_such_tool")]).size).toBe(0);
    expect(checkToolCalls(ALL_ORCHESTRATOR_TOOLS as any, [call({ data: "x" })], undefined).size).toBe(0);
  });
});
