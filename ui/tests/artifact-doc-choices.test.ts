import { expect, test } from "vitest";
import {
  choiceTemplates, choiceToMarkdown, decodeDocChoice, encodeDocChoice, readChoiceDefinitions, updateChoiceDefinition,
} from "../src/components/artifacts/artifact-doc-choices";

test("a choice survives Markdown encoding with escaped text and an independent selection", () => {
  const template = choiceTemplates[0];
  const choice = { ...template, name: "Track & approve", selected: "doing" };
  expect(decodeDocChoice(encodeDocChoice(choice))).toEqual(choice);
  const unset = choiceToMarkdown({ ...choice, selected: undefined });
  expect(unset).toContain(">Track &amp; approve</span>");
  expect(readChoiceDefinitions(unset)).toEqual([{ ...template, name: choice.name }]);
});

test("updates all copies of one dropdown while preserving or clearing each selection", () => {
  const status = choiceTemplates[0];
  const priority = choiceTemplates[1];
  const markdown = [
    choiceToMarkdown({ ...status, selected: "todo" }),
    choiceToMarkdown({ ...priority, selected: "low" }),
    choiceToMarkdown({ ...status, selected: "done" }),
  ].join(" versus ");
  const revised = {
    ...status,
    options: [{ ...status.options[0], label: "Ready" }, status.options[1]],
  };
  const result = updateChoiceDefinition(markdown, revised);
  expect(result).toContain(">Ready</span> versus ");
  expect(result).toContain(choiceToMarkdown({ ...priority, selected: "low" }));
  expect(result.endsWith(">Status</span>")).toBe(true);
});
