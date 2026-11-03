import { describe, expect, test } from "vitest";
import { outputFolderLink, taskOutputFolder } from "@/lib/output-folders";

describe("output folder links", () => {
  const data = JSON.stringify({ tasks: [{ title: "crea una frase" }, { title: "crea il disegno" }] });

  test("a task that ran links to its numbered folder in the mission run's folder", () => {
    const folder = taskOutputFolder({ id: "t2", title: "crea il disegno", group: "diegno-random (4)", status: "done" }, data);
    expect(folder).toBe("output/diegno-random (4)/02 - crea il disegno");
    expect(outputFolderLink(folder!)).toBe("/files?workspacePath=output%2Fdiegno-random+%284%29%2F02+-+crea+il+disegno");
  });

  test("a task that has not run yet has no folder", () => {
    expect(taskOutputFolder({ id: "t1", title: "x", group: "m", status: "pending" }, data)).toBeUndefined();
  });
});
