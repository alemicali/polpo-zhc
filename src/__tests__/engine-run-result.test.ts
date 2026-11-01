import { describe, expect, test } from "vitest";
import { runResult } from "../adapters/engine.js";

const user = { role: "user", content: [{ type: "text", text: "Draw it" }] };

describe("result of an agent run", () => {
  test("a run ending with a provider error fails with the reason, instead of passing with no output", () => {
    // Ollama answered HTTP 500: the model crashed while loading
    const failed = runResult([user, { role: "assistant", content: [], stopReason: "error", errorMessage: "500 llama-server process has terminated" }]);
    expect(failed).toEqual({ exitCode: 1, stdout: "", stderr: "Model error: 500 llama-server process has terminated" });
    expect(runResult([user, { role: "assistant", content: [], stopReason: "error" }]).stderr).toBe("Model error: the model returned an error");
  });

  test("stopped at the turn limit: not a model error; the expectations decide, and the output says so", () => {
    // Seen: an agent wrote the right file, then kept going until the engine aborted it at 150 turns
    const aborted = [user, { role: "assistant", content: [{ type: "text", text: "Saved codice.txt." }], stopReason: "toolUse" },
      { role: "assistant", content: [], stopReason: "error", errorMessage: "The operation was aborted." }];
    expect(runResult(aborted, { turnLimit: 150 })).toEqual({ exitCode: 0, stdout: "Saved codice.txt.\n\n[Stopped at the turn limit (150 turns)]", stderr: "" });
    // the same abort without the turn limit (e.g. the task was killed) is a failure
    expect(runResult(aborted).exitCode).toBe(1);
    expect(runResult([user, { role: "assistant", content: [], stopReason: "aborted" }]).exitCode).toBe(1);
  });

  test("a finished run passes with the last text the agent wrote", () => {
    const messages = [
      user,
      { role: "assistant", content: [{ type: "text", text: "Saving the drawing." }, { type: "toolCall", name: "write" }], stopReason: "toolUse" },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" },
    ];
    expect(runResult(messages)).toEqual({ exitCode: 0, stdout: "Saving the drawing.", stderr: "" });
    expect(runResult([user, { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" }]).stdout).toBe("Done.");
  });
});
