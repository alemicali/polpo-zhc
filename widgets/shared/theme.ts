/**
 * The cards' colours from the instance's look: the server passes the brand, status and agent
 * colours its custom look sets, per mode (card.appearance, see widgetAppearance in
 * packages/core/src/appearance.ts). They become --polpo-* variables on the document, each a
 * light-dark() pair so the host's light or dark theme still picks the mode; the stylesheet's token
 * block (agent-card/style.css) prefers them over the host's colours and its own defaults.
 */
type Modes = { light?: Record<string, string>; dark?: Record<string, string> } | undefined;

/** A colour as the server checked it (#rgb…, oklch(…), hsl(…), rgb(…)): nothing else reaches CSS. */
const COLOR = /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:oklch|oklab|lab|lch|hsla?|rgba?)\(\s*[0-9a-zA-Z.%\s,/+-]{1,80}\))$/;

/** token name → the --polpo-* variable(s) it sets (status colours also tint their backgrounds). */
const VARS: Record<string, string> = {
  primary: "--polpo-primary",
  success: "--polpo-success",
  warning: "--polpo-warning",
  info: "--polpo-info",
  destructive: "--polpo-danger",
};
for (let i = 1; i <= 10; i++) {
  VARS[`agent${i}`] = `--polpo-agent-${i}`;
  VARS[`agent${i}Foreground`] = `--polpo-agent-${i}-fg`;
}
const TINTED = new Set(["success", "warning", "info", "destructive"]);

let applied: string[] = [];

export function applyInstanceAppearance(modes: Modes): void {
  const root = document.documentElement;
  for (const v of applied) root.style.removeProperty(v);
  applied = [];
  if (!modes) return;
  for (const [name, variable] of Object.entries(VARS)) {
    const light = modes.light?.[name];
    const dark = modes.dark?.[name];
    const l = typeof light === "string" && COLOR.test(light.trim()) ? light.trim() : undefined;
    const d = typeof dark === "string" && COLOR.test(dark.trim()) ? dark.trim() : undefined;
    if (!l && !d) continue;
    const value = l && d ? `light-dark(${l}, ${d})` : (l ?? d)!;
    root.style.setProperty(variable, value);
    applied.push(variable);
    if (TINTED.has(name)) {
      const bg = `${variable}-bg`;
      root.style.setProperty(bg, `color-mix(in srgb, ${value} 16%, transparent)`);
      applied.push(bg);
    }
  }
}
