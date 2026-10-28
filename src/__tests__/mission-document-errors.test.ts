import { describe, expect, test } from "vitest";
import { parseMissionDocument } from "../core/schemas.js";

describe("mission document errors", () => {
  test("name the task to fix, not only its index", () => {
    const doc = { name: "prova", tasks: [{ title: "test", description: "", assignTo: "dev" }, { title: "New task", description: "", dependsOn: ["test"] }] };
    expect(() => parseMissionDocument(doc)).toThrow(
      'Invalid mission document: task "test" (tasks.0).description: task requires a description; task "New task" (tasks.1).description: task requires a description',
    );
  });

  test("an item without a title or name keeps the plain path", () => {
    expect(() => parseMissionDocument({ name: "x", tasks: [{ description: "d" }] })).toThrow(/tasks\.0\.title/);
  });
});
