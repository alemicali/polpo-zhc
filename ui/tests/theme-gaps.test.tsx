/**
 * The theme gaps closed for custom looks: the primary button's glow (shadowButtonPrimary), the
 * dialogs' own shadow (shadowDialog, default shadowRaised), and agents listed with their colour
 * (the shared AgentAvatar, never a plain Bot icon).
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appearanceKit } from "@/lib/appearance-kit";
import { cn } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { AccessEditor } from "@/components/connectors/connector-detail-sheet";
import { agentColorIndexFromName } from "@/lib/agent-colors";
import { APPEARANCE_TOKENS, parseAppearanceSettings, sanitizeAppearanceSettings } from "../../packages/core/src/appearance";

const UI = resolve(process.cwd(), process.cwd().endsWith("/ui") ? "." : "ui");
const kit = appearanceKit();
const css = (light: Record<string, unknown>, dark: Record<string, unknown> = {}) => kit.overridesCss(kit.normalizeCustom({ enabled: true, light, dark }))!;
const index = readFileSync(resolve(UI, "src/index.css"), "utf8");
const read = (f: string) => readFileSync(resolve(UI, `src/${f}`), "utf8");
const GLOW = "0 0 20px oklch(0.6 0.2 290 / 40%)";

describe("shadowButtonPrimary and shadowDialog", () => {
  it("are shadow tokens, the same in the dashboard and on the server, validated like every shadow", () => {
    expect(APPEARANCE_TOKENS.shadowButtonPrimary).toEqual({ css: "--shadow-button-primary", group: "brand", kind: "shadow" });
    expect(APPEARANCE_TOKENS.shadowDialog).toEqual({ css: "--shadow-dialog", group: "shape", kind: "shadow" });
    expect(kit.TOKENS.shadowButtonPrimary).toEqual(["--shadow-button-primary", "brand", "shadow"]);
    expect(kit.TOKENS.shadowDialog).toEqual(["--shadow-dialog", "shape", "shadow"]);
    const ok = parseAppearanceSettings({ custom: { enabled: true, light: { shadowButtonPrimary: GLOW, shadowDialog: "none" }, dark: { shadowButtonPrimary: "none" } } });
    expect(ok.custom).toMatchObject({ light: { shadowButtonPrimary: GLOW, shadowDialog: "none" }, dark: { shadowButtonPrimary: "none" } });
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { shadowButtonPrimary: "0 0 4px; color: red" } } })).toThrow(/box-shadow/);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, dark: { shadowDialog: "0 0 1px url(https://evil)" } } })).toThrow(/box-shadow/);
    // a hand-edited config keeps the good one
    const { value, problems } = sanitizeAppearanceSettings({ custom: { enabled: true, light: { shadowDialog: "0 8px 24px rgb(0 0 0 / 20%)", shadowButtonPrimary: "{}" } } });
    expect(value.custom?.light).toEqual({ shadowDialog: "0 8px 24px rgb(0 0 0 / 20%)" });
    expect(problems.join(" ")).toMatch(/shadowButtonPrimary/);
  });

  it("default to today's look: no button shadow, dialogs as raised as popovers", () => {
    expect(index).toContain("--shadow-button-primary: 0 0 #0000;");
    expect(index).toContain("--shadow-button-primary-hover: var(--shadow-button-primary);");
    expect(index).toContain("--shadow-dialog: var(--shadow-raised);");
    for (const u of ["@utility shadow-button-primary {", "@utility shadow-button-primary-hover {", "@utility shadow-dialog {"]) expect(index).toContain(u);
    // a look that sets neither writes neither
    const out = css({ primary: "#7c3aed" });
    expect(out).not.toContain("--shadow-button-primary");
    expect(out).not.toContain("--shadow-dialog");
    // Redline's flat newsprint keeps the look's own shadows
    expect(index).toContain('[data-palette="redline"] [class*="shadow-"]:not(.shadow-card, .shadow-raised, .shadow-dialog, .shadow-button-primary)');
  });

  it("write the variables per mode; the button's hover adds the strong glow only when a glow is set", () => {
    const out = css({ shadowButtonPrimary: GLOW, shadowDialog: "0 10px 15px -3px rgb(0 0 0 / 10%)" }, { shadowButtonPrimary: "none" });
    const at = out.indexOf("html:root.dark");
    const [light, dark] = [out.slice(0, at), out.slice(at)];
    expect(light).toContain(`--shadow-button-primary: ${GLOW};`);
    expect(light).toContain(`--shadow-button-primary-hover: ${GLOW}, var(--shadow-glow-strong) color-mix(in oklch, var(--primary) 55%, transparent);`);
    expect(light).toContain("--shadow-dialog: 0 10px 15px -3px rgb(0 0 0 / 10%);");
    expect(dark).toContain("--shadow-button-primary: 0 0 #0000;");
    expect(dark).toContain("--shadow-button-primary-hover: 0 0 #0000;");
    expect(dark).not.toContain("--shadow-dialog");
  });

  it("are used: the default button, dialogs and sheets; popovers and menus keep shadowRaised", () => {
    const def = buttonVariants({ variant: "default" });
    expect(def).toContain("shadow-button-primary");
    expect(def).toContain("hover:shadow-button-primary-hover");
    for (const v of ["outline", "secondary", "ghost", "destructive", "link"] as const) expect(buttonVariants({ variant: v })).not.toContain("shadow-button-primary");
    // tailwind-merge knows them as shadows: a caller's shadow replaces it, rings stay
    expect(cn(def, "shadow-glow")).not.toMatch(/(^| )shadow-button-primary( |$)/);
    expect(cn("shadow-dialog", "ring-2")).toBe("shadow-dialog ring-2");
    expect(read("components/ui/dialog.tsx")).toContain("shadow-dialog");
    expect(read("components/ui/dialog.tsx")).not.toContain("shadow-raised");
    expect(read("components/ui/sheet.tsx")).toContain("shadow-dialog");
    expect(read("components/ui/sheet.tsx")).not.toContain("shadow-raised");
    for (const f of ["popover", "dropdown-menu", "select", "hover-card", "context-menu"]) expect(read(`components/ui/${f}.tsx`), f).toContain("shadow-raised");
  });
});

describe("rendered", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("the primary button carries the glow classes", () => {
    act(() => root.render(<><Button>Go</Button><Button variant="outline">Other</Button></>));
    const [primary, outline] = [...host.querySelectorAll("button")];
    expect(primary.className).toContain("shadow-button-primary");
    expect(primary.className).toContain("hover:shadow-button-primary-hover");
    expect(outline.className).not.toContain("shadow-button-primary");
  });

  it("Configuration → Appearance has both tokens and previews them", async () => {
    const { AppearanceEditor } = await import("@/components/config/appearance-editor");
    act(() => root.render(<AppearanceEditor onSaveInstanceDefault={vi.fn(async () => {})} />));
    expect(host.textContent).toContain("Shadow Button Primary");
    expect(host.textContent).toContain("Shadow Dialog");
    expect((host.querySelector('[data-testid="appearance-preview-button"]') as HTMLElement).style.boxShadow).toBe("var(--pv-button-shadow)");
    expect((host.querySelector('[data-testid="appearance-preview-dialog"]') as HTMLElement).style.boxShadow).toBe("var(--pv-dialog-shadow)");
  });

  it("the connector's 'Who can use it' list shows each agent in its colour, not a plain Bot icon", () => {
    const agents = [{ name: "alice", label: "Alice" }, { name: "bob", label: "Bob" }];
    act(() => root.render(<AccessEditor access={{ polpo: true, agents: [] }} agents={agents} onChange={() => {}} />));
    for (const a of agents) {
      const row = [...host.querySelectorAll("span.block")].find((s) => s.textContent === a.label)?.closest("div");
      expect(row, a.name).toBeTruthy();
      const avatar = row!.querySelector(`.bg-agent-${agentColorIndexFromName(a.name)}`);
      expect(avatar, a.name).toBeTruthy();
      expect(avatar!.textContent).toBe(a.name.slice(0, 2).toUpperCase());
    }
    expect(host.querySelector("svg.lucide-bot")).toBeNull();
  });

  it("AgentAvatar's icon fallback keeps the agent's colour when only a size is given", () => {
    act(() => root.render(<AgentAvatar name="alice" size="md" iconClassName="shrink-0" />));
    const svg = host.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain(`text-agent-${agentColorIndexFromName("alice")}`);
    expect(svg.getAttribute("class")).toContain("shrink-0");
  });

  it("lists of agents use the shared avatar, not a plain Bot icon", () => {
    for (const f of ["components/connectors/connector-detail-sheet.tsx", "components/tasks/task-tool-scope.tsx", "components/computers/computer-card.tsx",
      "components/computers/computers-table.tsx", "pages/computer-detail.tsx", "pages/skill-detail.tsx", "pages/playbook-detail.tsx"]) {
      expect(read(f), f).toContain("<AgentAvatar");
    }
    expect(read("components/connectors/connector-detail-sheet.tsx")).not.toMatch(/<Bot\b/);
    expect(read("pages/mission-detail.tsx")).not.toMatch(/<Bot\b/);
  });
});
