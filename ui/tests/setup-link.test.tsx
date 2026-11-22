/**
 * Links from an assistant (MCP setup_url): the page reads section, item and field, focuses the field,
 * and after the save says "Done — go back to your assistant" once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const success = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...a: unknown[]) => success(...a) } }));

const { findSetupField, focusSetupField, notifySetupSaved, readSetupParams } = await import("@/lib/setup-link");

afterEach(() => {
  document.body.innerHTML = "";
  success.mockClear();
  window.history.replaceState(null, "", "/");
});

describe("setup links", () => {
  it("reads the section, the item, the field and the setup id (also inside the hash, for Electron)", () => {
    expect(readSetupParams("?section=channels&channel=ops&focus=botToken&setup=channel%3Aops%3AbotToken")).toEqual({
      section: "channels", channel: "ops", focus: "botToken", setup: "channel:ops:botToken",
    });
    window.history.replaceState(null, "", "/#/config?section=providers&provider=openai&focus=apiKey");
    expect(readSetupParams()).toEqual({ section: "providers", provider: "openai", focus: "apiKey" });
  });

  it("finds the field of the right item and focuses it once it appears", async () => {
    document.body.innerHTML = `
      <div data-setup-item="e2b"><button data-setup-field="credential" id="e2b">e2b</button></div>
      <div data-setup-item="daytona"><button data-setup-field="credential" id="daytona">daytona</button></div>`;
    expect(findSetupField(document, { focus: "credential", provider: "daytona" })?.id).toBe("daytona");
    expect(findSetupField(document, { focus: "credential" })?.id).toBe("e2b");
    expect(findSetupField(document, { section: "sync" })).toBeNull();

    // the dialog opens a moment later: it waits for the field
    const stop = focusSetupField({ focus: "botToken" }, document, 2000);
    setTimeout(() => { document.body.insertAdjacentHTML("beforeend", '<input data-setup-field="botToken" id="tok">'); }, 150);
    await new Promise((r) => setTimeout(r, 400));
    expect(document.activeElement?.id).toBe("tok");
    stop();
  });

  it("after a save from an assistant's link: the toast once, the setup parameters dropped", () => {
    window.history.replaceState(null, "", "/config?section=channels&channel=ops&focus=botToken&setup=channel%3Aops%3AbotToken");
    expect(notifySetupSaved()).toBe(true);
    expect(success).toHaveBeenCalledWith("Done — go back to your assistant", expect.anything());
    expect(window.location.search).toBe("?section=channels&channel=ops");
    expect(notifySetupSaved()).toBe(false);
    expect(success).toHaveBeenCalledTimes(1);
  });
});
