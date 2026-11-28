import { expect, test } from "vitest";
import { AGENT_DEFAULT, sandboxWithComputer, taskComputerOptions } from "../src/lib/task-computer";

const computers = [{ id: "ms-nina-01", name: "Nina" }, { id: "daytona-box", name: "Daytona box" }];
const nina = { name: "nina", computers: ["ms-nina-01", "daytona-box"], defaultComputer: "ms-nina-01" };

test("the select offers the agent's default first, its computers, this server and a fresh sandbox", () => {
  expect(taskComputerOptions(nina, computers)).toEqual([
    { value: AGENT_DEFAULT, label: "Agent default (Nina)" },
    { value: "host", label: "This server" },
    { value: "ms-nina-01", label: "Nina · ms-nina-01" },
    { value: "daytona-box", label: "Daytona box · daytona-box" },
    { value: "ephemeral", label: "Fresh sandbox (ephemeral)" },
  ]);
  // an agent without computers: this server only
  expect(taskComputerOptions({ name: "writer" }, computers).map((o) => o.value)).toEqual([AGENT_DEFAULT, "host", "ephemeral"]);
  // a computer the task names but the agent no longer has stays visible
  expect(taskComputerOptions({ name: "writer" }, computers, "daytona-box").at(-1)).toEqual({ value: "daytona-box", label: "Daytona box (not one of the agent's computers)" });
});

test("changing the computer keeps the task's other sandbox settings", () => {
  expect(sandboxWithComputer(undefined, "daytona-box")).toEqual({ computer: "daytona-box" });
  expect(sandboxWithComputer({ computer: "daytona-box", network: { mode: "open" } }, AGENT_DEFAULT)).toEqual({ network: { mode: "open" } });
  expect(sandboxWithComputer({ computer: "daytona-box" }, AGENT_DEFAULT)).toBeNull();
});
