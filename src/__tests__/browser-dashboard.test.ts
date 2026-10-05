import { describe, expect, it } from "vitest";
import {
  browserSessionCommandArgs,
  browserVncCommandArgs,
  browserViewportCommandArgs,
  rewriteDashboardHtml,
  shouldPauseVncUpstream,
  shouldResumeVncUpstream,
  VNC_WS_HIGH_WATER_MARK,
  VNC_WS_LOW_WATER_MARK,
} from "../server/routes/browser-dashboard.js";

describe("browser dashboard proxy", () => {
  it("rewrites Next assets and injects local HTTP/WebSocket routing", () => {
    const html = [
      "<html><head>",
      '<link rel="stylesheet" href="/_next/static/app.css">',
      '<script src="/_next/static/app.js"></script>',
      '<link rel="icon" href="/favicon.ico?hash">',
      "</head><body>",
      '<script>self.__next_f.push([1,"\\\"/_next/static/lazy.js\\\""])</script>',
      "</body></html>",
    ].join("");

    const rewritten = rewriteDashboardHtml(html);

    expect(rewritten).not.toContain('href="/_next/');
    expect(rewritten).not.toContain('src="/_next/');
    expect(rewritten).toContain('/api/v1/browser-dashboard/view/_next/static/app.css');
    expect(rewritten).toContain('/api/v1/browser-dashboard/view/_next/static/app.js');
    expect(rewritten).toContain('/api/v1/browser-dashboard/view/_next/static/lazy.js');
    expect(rewritten).toContain('/api/v1/browser-dashboard/view/favicon.ico?hash');
    expect(rewritten).toContain("window.fetch = function");
    expect(rewritten).toContain("window.WebSocket = PatchedWebSocket");
    expect(rewritten).toContain("/api/v1/browser-dashboard/cdp/");
    expect(rewritten).toContain('[data-testid="activity"]');
    expect(rewritten).toContain('[data-testid="sessions"]');
    expect(rewritten).toContain('[data-testid="viewport"]');
    expect(rewritten).toContain("flex-grow: 100 !important");
    expect(rewritten).toContain("polpo:select-session");
    expect(rewritten).toContain("sessionName");
    expect(rewritten).toContain('id$="-trigger-viewport"');
    expect(rewritten).toContain('id$="-trigger-sessions"');
    expect(rewritten).toContain("new MouseEvent('mousedown'");
    expect(rewritten.indexOf("window.fetch = function")).toBeLessThan(
      rewritten.indexOf('/api/v1/browser-dashboard/view/_next/static/app.js'),
    );
  });
});

describe("native Agent Live commands", () => {
  it("builds typed agent-browser tab and navigation commands", () => {
    expect(browserSessionCommandArgs("orchestrator", { action: "activate-tab", tabId: "t2" }))
      .toEqual(["--session", "orchestrator", "tab", "t2", "--json"]);
    expect(browserSessionCommandArgs("task-42", { action: "new-tab", url: "https://example.com" }))
      .toEqual(["--session", "task-42", "tab", "new", "https://example.com", "--json"]);
    expect(browserSessionCommandArgs("task-42", { action: "reload" }))
      .toEqual(["--session", "task-42", "reload", "--json"]);
  });

  it("rejects unsafe session and tab references", () => {
    expect(browserSessionCommandArgs("../other", { action: "back" })).toBeNull();
    expect(browserSessionCommandArgs("orchestrator", { action: "close-tab", tabId: "first" })).toBeNull();
    expect(browserSessionCommandArgs("orchestrator", { action: "navigate", url: "  " })).toBeNull();
  });

  it("bounds responsive viewport updates", () => {
    expect(browserViewportCommandArgs("orchestrator", 1280, 720))
      .toEqual(["--session", "orchestrator", "set", "viewport", "1280", "720", "--json"]);
    expect(browserViewportCommandArgs("orchestrator", 960, 540, 2))
      .toEqual(["--session", "orchestrator", "set", "viewport", "960", "540", "2", "--json"]);
    expect(browserViewportCommandArgs("orchestrator", 200, 720)).toBeNull();
    expect(browserViewportCommandArgs("orchestrator", 2560, 1440)).toBeNull();
    expect(browserViewportCommandArgs("orchestrator", 960, 540, 3)).toBeNull();
  });

  it("binds TigerVNC to localhost with a low-latency update budget", () => {
    const args = browserVncCommandArgs(":99", 5900, "tigervnc");
    expect(args).toContain("-localhost=1");
    expect(args).toContain("-AlwaysShared=1");
    expect(args).toContain("-FrameRate=30");
    expect(args).toContain("-PollingCycle=5");
    expect(args).toContain("-MaxProcessorUsage=80");
    expect(browserVncCommandArgs(":99", 5900, "tigervnc", "1280x720+0+0"))
      .toEqual(expect.arrayContaining(["-Geometry", "1280x720+0+0"]));
    expect(browserVncCommandArgs(":99", 5900, "x11vnc")).toContain("-threads");
    expect(browserVncCommandArgs(":99", 5900, "x11vnc", "1280x720+0+0"))
      .toEqual(expect.arrayContaining(["-clip", "1280x720+0+0"]));
    expect(browserVncCommandArgs("example.com:0", 5900)).toBeNull();
    expect(browserVncCommandArgs(":99", 80)).toBeNull();
    expect(browserVncCommandArgs(":99", 5900, "tigervnc", "../../bad")).toBeNull();
  });

  it("applies backpressure before the VNC websocket builds a stale frame queue", () => {
    expect(VNC_WS_HIGH_WATER_MARK).toBe(512 * 1024);
    expect(VNC_WS_LOW_WATER_MARK).toBe(128 * 1024);
    expect(shouldPauseVncUpstream(VNC_WS_HIGH_WATER_MARK - 1)).toBe(false);
    expect(shouldPauseVncUpstream(VNC_WS_HIGH_WATER_MARK)).toBe(true);
    expect(shouldResumeVncUpstream(VNC_WS_LOW_WATER_MARK)).toBe(true);
    expect(shouldResumeVncUpstream(VNC_WS_LOW_WATER_MARK + 1)).toBe(false);
  });
});
