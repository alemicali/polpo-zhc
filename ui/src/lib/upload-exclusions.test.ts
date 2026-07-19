import { describe, expect, test } from "vitest";
import {
  describeUploadExclusions,
  mergeUploadExclusions,
  uploadPathExclusion,
} from "./upload-exclusions";

describe("upload exclusions", () => {
  test("excludes generated directories at any nesting level", () => {
    expect(uploadPathExclusion("project/node_modules/pkg/index.js")).toEqual({
      kind: "directory",
      reason: "node_modules",
      path: "project/node_modules",
    });
    expect(uploadPathExclusion("project/.next/cache/data.bin")?.reason).toBe(".next");
    expect(uploadPathExclusion("project/src/index.ts")).toBeUndefined();
  });

  test("dist is allowed as an individual file but excluded as a directory", () => {
    expect(uploadPathExclusion("dist", "file")).toBeUndefined();
    expect(uploadPathExclusion("dist", "directory")?.reason).toBe("dist");
  });

  test("summarizes skipped folders and files without duplicates", () => {
    const exclusions = mergeUploadExclusions(
      { files: 2, directories: ["project/node_modules"], reasons: ["node_modules"] },
      { files: 1, directories: ["project/node_modules"], reasons: ["node_modules", ".DS_Store"] },
    );
    expect(describeUploadExclusions(exclusions)).toBe(
      "Excluded 1 generated folder and 3 files (node_modules, .DS_Store)",
    );
  });
});
