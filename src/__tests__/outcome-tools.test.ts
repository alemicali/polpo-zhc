import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createOutcomeTools } from "../tools/outcome-tools.js";

const TMP = "/tmp/polpo-outcome-tools-test";
const txt = (r: any) => r.content.map((c: any) => c.text).join("");

describe("Outcome Tools — register_outcome", () => {
  beforeAll(() => {
    mkdirSync(TMP, { recursive: true });
    // Create test files
    writeFileSync(join(TMP, "report.pdf"), Buffer.from("fake-pdf"));
    writeFileSync(join(TMP, "chart.png"), Buffer.from("fake-png"));
    writeFileSync(join(TMP, "data.xlsx"), Buffer.from("fake-xlsx"));
  });

  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  function getTool() {
    const tools = createOutcomeTools(TMP);
    return tools.find(t => t.name === "register_outcome")!;
  }

  it("registers a file outcome with auto-detected mime type", async () => {
    const tool = getTool();
    const result = await tool.execute("t1", {
      type: "file",
      label: "Sales Report",
      path: "report.pdf",
    });

    const output = txt(result);
    expect(output).toContain('Outcome registered: "Sales Report" (file)');
    expect(output).toContain("report.pdf");
    expect(output).toContain("MIME: application/pdf");

    expect(result.details.outcomeType).toBe("file");
    expect(result.details.outcomeLabel).toBe("Sales Report");
    expect(result.details.path).toContain("report.pdf");
    expect(result.details.outcomeMimeType).toBe("application/pdf");
    expect(result.details.outcomeSize).toBeGreaterThan(0);
  });

  it("registers a media outcome", async () => {
    const tool = getTool();
    const result = await tool.execute("t2", {
      type: "media",
      label: "Revenue Chart",
      path: "chart.png",
    });

    expect(result.details.outcomeType).toBe("media");
    expect(result.details.outcomeMimeType).toBe("image/png");
  });

  it("registers a text outcome", async () => {
    const tool = getTool();
    const result = await tool.execute("t3", {
      type: "text",
      label: "Analysis Summary",
      text: "Revenue increased by 23% quarter over quarter, driven by enterprise sales.",
    });

    const output = txt(result);
    expect(output).toContain("Analysis Summary");
    expect(result.details.outcomeType).toBe("text");
    expect(result.details.outcomeText).toContain("Revenue increased");
  });

  it("registers a URL outcome", async () => {
    const tool = getTool();
    const result = await tool.execute("t4", {
      type: "url",
      label: "Staging Deploy",
      url: "https://staging.example.com",
    });

    expect(result.details.outcomeType).toBe("url");
    expect(result.details.outcomeUrl).toBe("https://staging.example.com");
  });

  it("registers a JSON outcome", async () => {
    const tool = getTool();
    const result = await tool.execute("t5", {
      type: "json",
      label: "API Response",
      data: { status: "ok", count: 42 },
    });

    expect(result.details.outcomeType).toBe("json");
    expect(result.details.outcomeData).toEqual({ status: "ok", count: 42 });
  });

  it("includes tags when provided", async () => {
    const tool = getTool();
    const result = await tool.execute("t6", {
      type: "file",
      label: "Q4 Report",
      path: "report.pdf",
      tags: ["report", "quarterly"],
    });

    expect(result.details.outcomeTags).toEqual(["report", "quarterly"]);
    const output = txt(result);
    expect(output).toContain("Tags: report, quarterly");
  });

  it("errors when path is missing for file type", async () => {
    const tool = getTool();
    const result = await tool.execute("t7", {
      type: "file",
      label: "Missing File",
    } as any);

    const output = txt(result);
    expect(output).toContain("Error: 'path' is required");
    expect(result.details.error).toBe("missing_path");
  });

  it("errors when text is missing for text type", async () => {
    const tool = getTool();
    const result = await tool.execute("t8", {
      type: "text",
      label: "Empty",
    } as any);

    const output = txt(result);
    expect(output).toContain("Error: 'text' is required");
    expect(result.details.error).toBe("missing_text");
  });

  it("errors when file does not exist on disk", async () => {
    const tool = getTool();
    const result = await tool.execute("t9", {
      type: "file",
      label: "Ghost",
      path: "nonexistent.pdf",
    });

    const output = txt(result);
    expect(output).toContain("Error: file not found");
    expect(result.details.error).toBe("file_not_found");
  });

  it("errors when url is missing for url type", async () => {
    const tool = getTool();
    const result = await tool.execute("t10", {
      type: "url",
      label: "No URL",
    } as any);

    const output = txt(result);
    expect(output).toContain("Error: 'url' is required");
    expect(result.details.error).toBe("missing_url");
  });

  it("errors when data is missing for json type", async () => {
    const tool = getTool();
    const result = await tool.execute("t11", {
      type: "json",
      label: "No Data",
    } as any);

    const output = txt(result);
    expect(output).toContain("Error: 'data' is required");
    expect(result.details.error).toBe("missing_data");
  });
});

describe("Outcome Tools — collectOutcome integration", () => {
  const INT_TMP = "/tmp/polpo-outcome-int-test";

  beforeAll(() => {
    mkdirSync(INT_TMP, { recursive: true });
    writeFileSync(join(INT_TMP, "report.pdf"), Buffer.from("fake-pdf"));
  });

  afterAll(() => {
    rmSync(INT_TMP, { recursive: true, force: true });
  });

  it("register_outcome details are consumable by collectOutcome pattern", async () => {
    // Simulate what engine.ts collectOutcome() does with register_outcome details
    const tools = createOutcomeTools(INT_TMP);
    const tool = tools.find(t => t.name === "register_outcome")!;
    const result = await tool.execute("t-int", {
      type: "file",
      label: "Integration Test PDF",
      path: "report.pdf",
      tags: ["test"],
    });

    const details = result.details as Record<string, unknown>;

    // These are the fields collectOutcome checks for register_outcome
    expect(details.outcomeType).toBe("file");
    expect(details.outcomeLabel).toBe("Integration Test PDF");
    expect(details.path).toBeDefined();
    expect(details.outcomeMimeType).toBe("application/pdf");
    expect(details.outcomeSize).toBeGreaterThan(0);
    expect(details.outcomeTags).toEqual(["test"]);
  });
});
