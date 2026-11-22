import { describe, expect, it } from "vitest";
import { errorActionUrl } from "@polpo-ai/core/error-action";

// The connect dialog and the connector sheet show a "Fix it" link for errors that say where to fix them.
describe("errorActionUrl", () => {
  it("finds the link of Slack's 'enable it here' error, in the JSON-RPC error or its message", () => {
    const message = "App is not enabled for Slack MCP server access. Please enable it here: https://api.slack.com/apps/A0123ABC/app-assistant";
    expect(errorActionUrl(message)).toBe("https://api.slack.com/apps/A0123ABC/app-assistant");
    expect(errorActionUrl(`Signed in, but the first connection failed: {"code":-32600,"message":"${message}"}`))
      .toBe("https://api.slack.com/apps/A0123ABC/app-assistant");
    expect(errorActionUrl(`${message}.`)).toBe("https://api.slack.com/apps/A0123ABC/app-assistant");
  });

  it("other instructions with a link count too", () => {
    expect(errorActionUrl("API not used in project 42. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42 then retry."))
      .toBe("https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=42");
    expect(errorActionUrl("An admin must approve this app (https://example.com/admin/apps)")).toBe("https://example.com/admin/apps");
  });

  it("no link without an instruction, nor without an https URL", () => {
    expect(errorActionUrl("Could not connect to https://mcp.example.com/mcp: ECONNREFUSED")).toBeUndefined();
    expect(errorActionUrl("Please enable the integration in the settings")).toBeUndefined();
    expect(errorActionUrl("Please enable it here: http://insecure.example.com/x")).toBeUndefined();
    expect(errorActionUrl(undefined)).toBeUndefined();
    expect(errorActionUrl("")).toBeUndefined();
  });
});
