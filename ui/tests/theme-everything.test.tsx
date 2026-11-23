/**
 * Nothing fixed: the agent colours (ten tokens per palette and mode, a stable pick per agent, an
 * override in its identity), the new shape and type tokens (validated the same in the dashboard
 * and on the server), the Appearance editor's Agents group, and the MCP cards' tokens.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appearanceKit } from "@/lib/appearance-kit";
import {
  AGENT_COLOR_COUNT, AGENT_COLOR_TOKENS, agentColor, agentColorClasses, agentColorIndex, agentColorIndexFromName, parseAgentColor, setAgentColorChoices,
} from "@/lib/agent-colors";
import { getTeamColor } from "@/components/agents/agents-team-colors";
import {
  APPEARANCE_NUMBER_RANGES, APPEARANCE_TOKENS, agentColorIndex as serverAgentColorIndex, agentColorIndexFromName as serverHash,
  parseAppearanceSettings, sanitizeAppearanceSettings, widgetAppearance,
} from "../../packages/core/src/appearance";

const UI = resolve(process.cwd(), process.cwd().endsWith("/ui") ? "." : "ui");
const kit = appearanceKit();
const css = (light: Record<string, unknown>, dark: Record<string, unknown> = {}) => kit.overridesCss(kit.normalizeCustom({ enabled: true, light, dark }))!;
const index = readFileSync(resolve(UI, "src/index.css"), "utf8");

describe("agent colours", () => {
  it("are ten tokens with a readable foreground, defined for light and dark by every palette", () => {
    for (let i = 1; i <= 10; i++) {
      expect(index).toContain(`--agent-${i}: oklch(var(--agent-l) var(--agent-c) calc(`);
      expect(index).toContain(`--agent-${i}-foreground: var(--agent-foreground);`);
      expect(index).toContain(`--color-agent-${i}: var(--agent-${i});`);
      expect(APPEARANCE_TOKENS[`agent${i}` as keyof typeof APPEARANCE_TOKENS]).toMatchObject({ css: `--agent-${i}`, group: "agents", kind: "color" });
      expect(kit.TOKENS[`agent${i}Foreground`]).toEqual([`--agent-${i}-foreground`, "agents", "color"]);
    }
    // the base light (:root) sets them; every other palette block, light and dark, sets its own lightness and chroma
    const blocks = index.split(/\n(?=(?::root|\.dark)(?:\[data-palette="[a-z]+"\])? \{)/).filter((b) => /--chart-5:/.test(b));
    expect(blocks).toHaveLength(18);
    for (const b of blocks) expect(b, b.slice(0, 40)).toMatch(/--agent-l: [\d.]+;\s*--agent-c: [\d.]+;/);
    // ten distinct hues
    const hues = [...index.matchAll(/--agent-\d+: oklch\(var\(--agent-l\) var\(--agent-c\) calc\((\d+) \+/g)].map((m) => Number(m[1]));
    expect(new Set(hues).size).toBe(10);
    const sorted = [...hues].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(25);
  });

  it("are picked stably from the name (the same as the server's), and spread over the ten", () => {
    expect(agentColorIndexFromName("alice")).toBe(agentColorIndexFromName("alice"));
    expect(agentColorIndexFromName(" Alice ")).toBe(agentColorIndexFromName("alice"));
    const names = ["alice", "bob", "carol", "dave", "eve", "frank", "grace", "heidi", "ivan", "judy", "mallory", "oscar", "peggy", "trent", "victor", "walter"];
    for (const n of names) {
      const i = agentColorIndexFromName(n);
      expect(i).toBeGreaterThanOrEqual(1);
      expect(i).toBeLessThanOrEqual(AGENT_COLOR_COUNT);
      expect(serverHash(n)).toBe(i);
      expect(serverAgentColorIndex(n, undefined)).toBe(i);
    }
    expect(new Set(names.map(agentColorIndexFromName)).size).toBeGreaterThanOrEqual(6);
  });

  it("an agent's own choice wins (identity.color: agent1 … agent10), never a raw colour", () => {
    expect(agentColorIndex("alice", "agent7")).toBe(7);
    expect(agentColorIndex("alice", 3)).toBe(3);
    expect(serverAgentColorIndex("alice", "agent10")).toBe(10);
    for (const bad of ["#ff0000", "agent0", "agent11", "red", 11, null]) {
      expect(parseAgentColor(bad)).toBeNull();
      expect(agentColorIndex("alice", bad)).toBe(agentColorIndexFromName("alice"));
    }
    expect(AGENT_COLOR_TOKENS).toHaveLength(10);
    expect(agentColor("alice", "agent4")).toMatchObject({ index: 4, token: "agent4", solid: "bg-agent-4 text-agent-4-foreground", text: "text-agent-4" });
    expect(agentColorClasses(11).index).toBe(1);
    expect(getTeamColor(12).text).toBe("text-agent-3");
    // the shared store (AgentColorsSync) takes valid choices only
    expect(() => setAgentColorChoices([{ name: "alice", identity: { color: "agent2" } }, { name: "bob", identity: { color: "#fff" } }])).not.toThrow();
  });

  it("the server validates identity.color the same way", () => {
    const schemas = readFileSync(resolve(UI, "../packages/server/src/schemas.ts"), "utf8");
    expect(schemas).toContain('color: z.string().regex(/^agent(?:[1-9]|10)$/');
  });

  it("can be set by a custom look, with the text on them derived readable", () => {
    const out = css({ agent3: "#1d4ed8" }, { agent3: "oklch(0.85 0.1 140)" });
    expect(out).toContain("--agent-3: #1d4ed8;");
    expect(out).toContain("--agent-3-foreground: #ffffff;");
    expect(out).toContain("--agent-3-foreground: #0f172a;");
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { agent3: "url(x)" } } })).toThrow(/agent3 must be a colour/);
    expect(parseAppearanceSettings({ custom: { enabled: true, dark: { agent10: "#abcdef", agent10Foreground: "#000" } } }).custom?.dark)
      .toEqual({ agent10: "#abcdef", agent10Foreground: "#000" });
  });
});

describe("the new shape, surface and type tokens", () => {
  it("are checked and bounded the same in the dashboard and on the server", () => {
    for (const name of ["radiusBadge", "radiusPill", "radiusAvatar", "radiusDialog", "surfaceBlur", "overlayBlur", "glowBlur",
      "fontWeightNormal", "fontWeightMedium", "fontWeightSemibold", "fontWeightBold"]) {
      expect(APPEARANCE_NUMBER_RANGES[name], name).toEqual(kit.RANGES[name]);
    }
    expect(kit.tokenValue("radiusPill", 5000)).toBe(999);
    expect(kit.tokenValue("radiusDialog", 40)).toBe(32);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { radiusDialog: 33 } } })).toThrow(/0 to 32/);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { fontWeightMedium: 950 } } })).toThrow(/100 to 900/);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { textXs: "200px" } } })).toThrow(/font size/);
    expect(() => parseAppearanceSettings({ custom: { enabled: true, light: { shadowGlow: "0 0 4px; color: red" } } })).toThrow(/box-shadow/);
    const ok = parseAppearanceSettings({ custom: { enabled: true, light: {
      radiusPill: 6, radiusAvatar: 8, radiusBadge: 4, radiusDialog: 12, textXs: "0.8rem", text2xl: "26px", fontWeightMedium: 450,
      shadowControl: "none", shadowGlow: "0 0 12px", surfaceBlur: 6, overlayBlur: 4, glowBlur: 80, overlay: "oklch(0 0 0 / 40%)", canvas: "#fafafa",
    } } }).custom!.light!;
    expect(ok).toMatchObject({ radiusPill: 6, textXs: "0.8rem", fontWeightMedium: 450, glowBlur: 80, canvas: "#fafafa" });
    // a hand-edited config keeps the good ones
    const { value, problems } = sanitizeAppearanceSettings({ custom: { enabled: true, light: { radiusAvatar: 8, textSm: "huge" } } });
    expect(value.custom?.light).toEqual({ radiusAvatar: 8 });
    expect(problems.join(" ")).toMatch(/textSm/);
  });

  it("write the variables Tailwind's utilities read", () => {
    const out = css({ radiusPill: 6, radiusAvatar: 999, textXs: "0.8rem", fontWeightBold: 650, surfaceBlur: 4, glowBlur: 40, canvas: "#fafafa" });
    for (const line of ["--radius-pill: 6px;", "--radius-avatar: 999px;", "--text-xs: 0.8rem;", "--font-weight-bold: 650;", "--surface-blur: 4px;", "--glow-blur: 40px;", "--canvas: #fafafa;", "--canvas-foreground: #0f172a;"]) {
      expect(out).toContain(line);
    }
    for (const decl of ["--radius-badge: 9999px;", "--radius-pill: 9999px;", "--radius-avatar: 9999px;", "--radius-dialog: var(--radius);",
      "--blur-surface: var(--surface-blur);", "--blur-overlay: var(--overlay-blur);", "--blur-glow: var(--glow-blur);", "--color-overlay: var(--overlay);",
      "--color-canvas: var(--canvas);", "@utility shadow-control", "@utility shadow-glow {", "@utility glow-*", "--radius-xs: calc(var(--radius) / 3);"]) {
      expect(index).toContain(decl);
    }
    expect(index).toContain("font-weight: var(--font-weight-semibold);");
  });

  it("are used by the components: badges, avatars, dialogs, the scrim, inputs", () => {
    const read = (f: string) => readFileSync(resolve(UI, `src/components/${f}`), "utf8");
    expect(read("ui/badge.tsx")).toContain("rounded-badge");
    expect(read("ui/avatar.tsx")).toContain("rounded-avatar");
    expect(read("ui/dialog.tsx")).toMatch(/bg-overlay backdrop-blur-overlay[\s\S]*rounded-dialog/);
    expect(read("ui/sheet.tsx")).toContain("bg-overlay backdrop-blur-overlay");
    expect(read("ui/input.tsx")).toContain("shadow-control");
    expect(read("shared/agent-avatar.tsx")).toContain("useAgentColor");
  });
});

describe("the MCP cards", () => {
  it("take the brand, status and agent colours a custom look sets, per mode", () => {
    expect(widgetAppearance(undefined)).toBeUndefined();
    expect(widgetAppearance({ custom: { enabled: false, light: { primary: "#111111" } } })).toBeUndefined();
    expect(widgetAppearance({ custom: { enabled: true, light: { primary: "#111111", agent2: "#222222", radius: 4, fontFamily: "Inter" }, dark: { info: "oklch(0.7 0.1 240)" } } }))
      .toEqual({ light: { primary: "#111111", agent2: "#222222" }, dark: { info: "oklch(0.7 0.1 240)" } });
  });

  it("write colours only in their token block, with the instance's first, then the host's", () => {
    const sheet = readFileSync(resolve(UI, "../widgets/agent-card/style.css"), "utf8");
    const rules = sheet.slice(sheet.indexOf('.avatar[data-color="1"]'));
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(|light-dark\(/i);
    expect(sheet).toContain("--w-info: var(--polpo-info, var(--color-text-info,");
    expect(sheet).toContain("--w-agent-3: var(--polpo-agent-3,");
    const work = readFileSync(resolve(UI, "../widgets/work-card/style.css"), "utf8");
    expect(work).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(|light-dark\(/i);
  });
});

describe("Configuration → Appearance", () => {
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

  it("has an Agents group with the ten colours, their text colours and a live preview", async () => {
    const { AppearanceEditor } = await import("@/components/config/appearance-editor");
    act(() => root.render(<AppearanceEditor onSaveInstanceDefault={vi.fn(async () => {})} />));
    expect(host.textContent).toContain("Agents");
    expect(host.textContent).toContain("Agent 1");
    expect(host.textContent).toContain("Agent 10 Foreground");
    const preview = host.querySelector('[data-testid="agent-colors-preview"]')!;
    expect(preview.children).toHaveLength(10);
    expect((preview.children[2] as HTMLElement).style.background).toBe("var(--agent-3)");
    // the shape group has the new corners, glows and blurs
    for (const name of ["Radius Pill", "Radius Avatar", "Shadow Glow", "Surface Blur", "Text Xs", "Font Weight Medium", "Canvas"]) {
      expect(host.textContent, name).toContain(name);
    }
  });
});
