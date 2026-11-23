import { expect, test } from "vitest";
import { decodeDocComment, encodeDocComment } from "../src/components/artifacts/artifact-doc-comments";
import { readArtifactDoc } from "../src/components/artifacts/artifact-doc-format";

test("keeps selected text and comment state when a document is reopened from Markdown", () => {
  const comment = { id: "note_123", body: "Review before publishing.", quote: "selected text", length: 13, resolved: true };
  const markdown = `A paragraph with selected text<span data-polpo-doc-comment="${encodeDocComment(comment)}"></span> and a tail.`;
  const { json, html } = readArtifactDoc(markdown);
  const paragraph = json.content?.[0];
  const marker = paragraph?.content?.find((child) => child.type === "docComment");
  expect(decodeDocComment(marker?.attrs?.comment)).toEqual(comment);
  expect(paragraph?.content?.filter((child) => child.type === "text").map((child) => child.text).join("")).toBe("A paragraph with selected text and a tail.");
  expect(html).toMatch(/data-polpo-doc-comment="[^"]+" aria-hidden="true"><\/span>/);
});

test("plain Markdown stays clear of comment metadata", () => {
  const { html } = readArtifactDoc("# Existing title\n\nOrdinary paragraph.");
  expect(html).toBe("<h1>Existing title</h1><p>Ordinary paragraph.</p>");
  expect(decodeDocComment("%not_encoded%")).toBeUndefined();
});
