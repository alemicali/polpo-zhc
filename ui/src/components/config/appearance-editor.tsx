/**
 * Configuration → Appearance: theme, palette and every design token, per mode, with a live
 * preview (the page itself). Edits are this browser's choices; "Save as instance default" makes
 * the current look everyone's default (settings.appearance), and "Use instance default" drops this
 * browser's choices.
 */
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { Check, Download, Globe, Laptop, Loader2, Moon, Palette as PaletteIcon, Plus, RotateCcw, Save, Sun, Upload, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { PALETTES, type Palette } from "@/lib/palette";
import {
  appearanceAsInstanceDefault, customizeInBrowser, followInstanceDefault, getInstanceAppearance, kit, setBrowserChoice,
  useResolvedAppearance, type AppearanceSettings, type InstanceAppearance,
} from "@/lib/appearance";
import type { GradientValue, TokenGroup, TokenMap, TokenValue, WebFont } from "@/lib/appearance-kit";
import { parseImportedAppearance } from "@/lib/appearance-import";
import { FONT_PRESETS } from "@/lib/font-presets";

const GROUPS: Array<{ id: TokenGroup; label: string; hint: string }> = [
  { id: "brand", label: "Brand", hint: "Buttons (solid or gradient), links, highlights" },
  { id: "surfaces", label: "Surfaces", hint: "Page, cards, menus, quiet areas" },
  { id: "text", label: "Text", hint: "On the page and on each surface" },
  { id: "borders", label: "Borders & focus", hint: "Lines, inputs, focus ring" },
  { id: "sidebar", label: "Sidebar", hint: "The navigation column; its opacity and backdrop blur" },
  { id: "charts", label: "Charts", hint: "Series colours" },
  { id: "status", label: "Status", hint: "Success, warning, info, errors (and text on them); task states" },
  { id: "typography", label: "Typography", hint: "Fonts (and web fonts to load); the type scale (rem or px); heading weight; label tracking and case" },
  { id: "shape", label: "Shape", hint: "Corners (global, cards, controls) and shadows" },
];

function label(name: string): string {
  return name.replace(/([A-Z])/g, " $1").replace(/([a-z])(\d)/, "$1 $2").replace(/^./, (c) => c.toUpperCase());
}

/** #rrggbb for the colour picker (any CSS colour, through a 1px canvas), or null. */
function toHex(color: string | undefined): string | null {
  if (!color) return null;
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c.slice(1).split("").map((x) => x + x).join("")}`.toLowerCase();
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return null;
  }
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string; icon?: typeof Sun }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-border/40 bg-muted/20 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors",
            value === o.value ? "bg-background text-foreground shadow-card" : "text-muted-foreground hover:text-foreground")}
        >
          {o.icon && <o.icon className="h-3.5 w-3.5" />}{o.label}
        </button>
      ))}
    </div>
  );
}

/** The primary button: solid (its fill, default the primary colour) or a gradient (two colours, an angle). */
function GradientRow({ value, computed, onChange }: {
  value: GradientValue | undefined;
  computed: string;
  onChange: (value: GradientValue | undefined) => void;
}) {
  const fallback = toHex(computed) ?? toHex(getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()) ?? "#000000";
  const g: GradientValue = value ?? { from: fallback, to: fallback, angle: kit.GRADIENT_ANGLE };
  const set = (patch: Partial<GradientValue>) => onChange(kit.tokenValue("buttonGradient", { ...g, ...patch }) as GradientValue | undefined);
  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-center gap-2 py-1">
      <span className="truncate text-xs" title="--button-primary-bg">Button style</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Segmented value={value ? "gradient" : "solid"} options={[{ value: "solid", label: "Solid" }, { value: "gradient", label: "Gradient" }]}
          onChange={(v) => onChange(v === "gradient" ? g : undefined)} />
        {value && (
          <>
            <input type="color" aria-label="Gradient start" value={toHex(g.from) ?? fallback} onChange={(e) => set({ from: e.target.value })}
              className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5" />
            <input type="color" aria-label="Gradient end" value={toHex(g.to) ?? fallback} onChange={(e) => set({ to: e.target.value })}
              className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5" />
            <input type="range" min={0} max={360} step={5} aria-label="Gradient angle" value={g.angle} onChange={(e) => set({ angle: Number(e.target.value) })}
              className="w-24 accent-primary" />
            <code className="w-10 shrink-0 text-right text-caption text-muted-foreground">{g.angle}°</code>
          </>
        )}
      </div>
      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!value} title="Back to a solid fill" onClick={() => onChange(undefined)}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Typography → web fonts: a family from Google Fonts (with weights) or a stylesheet on an allowed host, with a preview. */
function WebFonts({ fonts, onChange, onUse }: {
  fonts: WebFont[];
  onChange: (fonts: WebFont[]) => void;
  onUse: (family: string) => void;
}) {
  const [family, setFamily] = useState("");
  const [source, setSource] = useState<"google" | "url">("google");
  const [weights, setWeights] = useState("400;600;700");
  const [url, setUrl] = useState("");
  const candidate = kit.normalizeWebFont({ family, source, weights: source === "google" ? weights : undefined, url: source === "url" ? url : undefined });
  const duplicate = !!candidate && fonts.some((f) => f.family.toLowerCase() === candidate.family.toLowerCase());
  const add = () => {
    if (!candidate || duplicate) return;
    onChange([...fonts, candidate]);
    setFamily("");
    setUrl("");
  };
  return (
    <div className="mt-2 space-y-2 border-t border-border/40 pt-2" data-testid="web-fonts">
      <div className="text-xs font-semibold">Web fonts</div>
      <p className="text-micro text-muted-foreground">
        Inter Tight is bundled; Satoshi, Inter, IBM Plex Sans, JetBrains Mono and Newsreader are always available. Add any other family here,
        then pick it above. Loaded with font-display swap from {kit.FONT_HOSTS.join(", ")}.
      </p>
      {fonts.map((f) => (
        <div key={f.family} className="flex items-center gap-2 rounded-control border border-border/40 px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-body" style={{ fontFamily: `"${f.family}", var(--app-font-family)` }}>{f.family} — The quick brown fox</span>
          <code className="hidden truncate text-micro text-muted-foreground sm:block">{f.source === "google" ? `Google${f.weights ? ` ${f.weights}` : ""}` : new URL(f.url ?? "https://x").hostname}</code>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-micro" onClick={() => onUse(f.family)}>Use</Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" title="Remove" onClick={() => onChange(fonts.filter((x) => x !== f))}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Input value={family} onChange={(e) => setFamily(e.target.value)} placeholder="Family, e.g. Manrope" aria-label="Web font family" className="h-8 w-40 text-caption" />
        <select aria-label="Web font source" value={source} onChange={(e) => setSource(e.target.value as "google" | "url")}
          className="h-8 rounded-control border border-border bg-background px-2 text-xs">
          <option value="google">Google Fonts</option>
          <option value="url">Stylesheet URL</option>
        </select>
        {source === "google"
          ? <Input value={weights} onChange={(e) => setWeights(e.target.value)} placeholder="400;600;700 or 300..800" aria-label="Web font weights" className="h-8 w-36 font-mono text-caption" />
          : <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://fonts.bunny.net/css?family=…" aria-label="Web font stylesheet" className="h-8 min-w-0 flex-1 font-mono text-caption" />}
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!candidate || duplicate || fonts.length >= 8} onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Add a web font
        </Button>
      </div>
      {family.trim() !== "" && !candidate && <p className="text-micro text-destructive">Check the family (letters, digits, spaces), the weights (100–900) or the URL (https, on an allowed host).</p>}
      {duplicate && <p className="text-micro text-destructive">{candidate?.family} is already added.</p>}
    </div>
  );
}

function TokenRow({ name, value, derived, computed, webFonts, onChange }: {
  name: string;
  value: string | number | undefined;
  derived: string | number | undefined;
  computed: string;
  webFonts: WebFont[];
  onChange: (value: string | number | undefined) => void;
}) {
  const kind = kit.TOKENS[name][2];
  const range = kit.RANGES[name] ?? [0, 24];
  const fontOptions = [...FONT_PRESETS, ...webFonts.map((f) => ({ label: f.family, value: `"${f.family}", ${name === "monoFont" ? "ui-monospace, monospace" : "ui-sans-serif, system-ui, sans-serif"}` }))];
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  const [source, setSource] = useState(value);
  if (source !== value) {
    setSource(value);
    setDraft(value === undefined ? "" : String(value));
  }
  const shown = value ?? derived;
  const placeholder = derived !== undefined ? `${derived} (derived)` : computed ? `${computed} (palette)` : "palette";
  const numeric = kind === "radius" || kind === "weight" || kind === "opacity" || kind === "blur";
  const invalid = draft.trim() !== "" && !numeric && kit.tokenValue(name, draft) === undefined;

  const commit = (text: string) => {
    setDraft(text);
    if (text.trim() === "") return onChange(undefined);
    const ok = kit.tokenValue(name, numeric ? Number(text) : text);
    if (ok !== undefined && typeof ok !== "object") onChange(ok);
  };

  return (
    <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-center gap-2 py-1">
      <span className="truncate text-xs" title={kit.TOKENS[name][0]}>
        {label(name)}
        {value === undefined && derived !== undefined && <span className="ml-1 text-micro uppercase text-muted-foreground">auto</span>}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        {kind === "color" && (
          <input
            type="color"
            aria-label={`${label(name)} colour`}
            value={toHex(typeof shown === "string" ? shown : computed) ?? "#000000"}
            onChange={(e) => commit(e.target.value)}
            className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
          />
        )}
        {kind === "radius" || kind === "blur" || kind === "opacity" ? (
          <>
            <input
              type="range" min={range[0]} max={range[1]} step={kind === "opacity" ? 0.05 : 1}
              aria-label={name === "radius" ? "Radius" : label(name)}
              value={typeof shown === "number" ? shown : kind === "opacity" ? 1 : kind === "blur" ? 0 : 8}
              onChange={(e) => commit(e.target.value)}
              className="w-full accent-primary"
            />
            <code className="w-12 shrink-0 text-right text-caption text-muted-foreground">
              {value === undefined ? (kind === "radius" && name !== "radius" ? "auto" : "palette") : kind === "opacity" ? `${Math.round(Number(value) * 100)}%` : `${value}px`}
            </code>
          </>
        ) : kind === "weight" ? (
          <>
            <input
              type="range" min={100} max={900} step={100}
              aria-label={label(name)}
              value={typeof shown === "number" ? shown : Number(computed) || 700}
              onChange={(e) => commit(e.target.value)}
              className="w-full accent-primary"
            />
            <code className="w-12 shrink-0 text-right text-caption text-muted-foreground">{value === undefined ? computed || "palette" : value}</code>
          </>
        ) : kind === "case" ? (
          <select
            aria-label={label(name)}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => commit(e.target.value)}
            className="h-8 w-40 rounded-md border border-border bg-background px-2 text-xs"
          >
            <option value="">{computed ? `${computed} (palette)` : "Palette"}</option>
            {["uppercase", "none", "capitalize", "lowercase"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : kind === "font" ? (
          <div className="flex min-w-0 flex-1 gap-2">
            <select
              aria-label={`${label(name)} preset`}
              value={fontOptions.some((f) => f.value === value) ? String(value) : ""}
              onChange={(e) => commit(e.target.value)}
              className="h-8 w-32 shrink-0 rounded-md border border-border bg-background px-2 text-xs"
            >
              <option value="">{value === undefined ? "Palette" : "Custom"}</option>
              {fontOptions.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
            </select>
            <Input value={draft} placeholder={placeholder} onChange={(e) => commit(e.target.value)}
              className={cn("h-8 min-w-0 font-mono text-caption", invalid && "border-destructive")} />
          </div>
        ) : (
          <Input value={draft} placeholder={placeholder} onChange={(e) => commit(e.target.value)}
            aria-label={label(name)}
            className={cn("h-8 min-w-0 font-mono text-caption", invalid && "border-destructive")} />
        )}
      </div>
      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={value === undefined} title="Back to the palette's value"
        onClick={() => commit("")}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function AppearanceEditor({ onSaveInstanceDefault }: {
  /** Save as everyone's default (null clears it); throws with a message on failure. */
  onSaveInstanceDefault: (value: InstanceAppearance | null) => Promise<void>;
}) {
  const resolved = useResolvedAppearance();
  const [mode, setMode] = useState<"light" | "dark">(resolved.dark ? "dark" : "light");
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const custom = resolved.custom;
  const tokens = custom[mode];
  const { tokens: withDerived } = useMemo(() => kit.deriveTokens(tokens, custom.derive), [tokens, custom.derive]);
  const customized = resolved.sources.theme === "browser" || resolved.sources.palette === "browser" || resolved.sources.custom === "browser";
  const instance = getInstanceAppearance();
  const hasInstance = !!instance && (instance.theme !== undefined || instance.palette !== undefined || instance.custom !== undefined);
  // the palette's own values, for placeholders (only for the mode on screen)
  const computed = (css: string) => (mode === (resolved.dark ? "dark" : "light")
    ? getComputedStyle(document.documentElement).getPropertyValue(css).trim() : "");

  const setCustom = (next: AppearanceSettings) => setBrowserChoice("custom", JSON.stringify(next));
  const setToken = (name: string, value: TokenValue | undefined) => {
    const nextTokens: TokenMap = { ...tokens };
    if (value === undefined) delete nextTokens[name];
    else nextTokens[name] = value;
    setCustom({ ...custom, enabled: true, [mode]: nextTokens });
  };
  const webFonts = custom.fonts ?? [];
  const setWebFonts = (fonts: WebFont[]) => {
    const next: AppearanceSettings = { ...custom };
    if (fonts.length) next.fonts = fonts;
    else delete next.fonts;
    setCustom(next);
  };
  const resetGroup = (group: TokenGroup) => {
    const nextTokens: TokenMap = {};
    for (const [k, v] of Object.entries(tokens)) if (kit.TOKENS[k]?.[1] !== group) nextTokens[k] = v;
    setCustom({ ...custom, [mode]: nextTokens });
  };

  const exportJson = () => {
    const json = JSON.stringify(appearanceAsInstanceDefault(resolved), null, 2);
    void navigator.clipboard?.writeText(json).catch(() => {});
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "polpo-appearance.json";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Appearance exported (also copied)");
  };
  const importJson = (text: string) => {
    const parsed = parseImportedAppearance(text);
    if (!parsed.ok) { toast.error(`Import failed: ${parsed.error}`); return; }
    if (parsed.value.theme) setBrowserChoice("theme", parsed.value.theme);
    if (parsed.value.palette) setBrowserChoice("palette", parsed.value.palette);
    if (parsed.value.custom || parsed.value.fonts) {
      const base = parsed.value.custom ? kit.normalizeCustom(parsed.value.custom) : custom;
      setCustom(parsed.value.fonts ? { ...base, fonts: parsed.value.fonts } : base);
    }
    setImportOpen(false);
    setImportText("");
    toast.success("Appearance imported in this browser");
  };

  const save = async (value: InstanceAppearance | null) => {
    setBusy(true);
    try {
      await onSaveInstanceDefault(value);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save the instance default");
    } finally {
      setBusy(false);
    }
  };

  const previewStyle = {
    "--pv-primary": String(withDerived.primary ?? "var(--primary)"),
    "--pv-primary-fg": String(withDerived.primaryForeground ?? "var(--primary-foreground)"),
    "--pv-button": typeof withDerived.buttonGradient === "object" ? kit.gradientCss(withDerived.buttonGradient)
      : String(withDerived.buttonPrimaryBg ?? withDerived.primary ?? "var(--button-primary-bg)"),
    "--pv-button-fg": String(withDerived.buttonPrimaryForeground ?? withDerived.primaryForeground ?? "var(--button-primary-foreground)"),
    "--pv-radius-card": typeof withDerived.radiusCard === "number" ? `${withDerived.radiusCard}px`
      : typeof withDerived.radius === "number" ? `${withDerived.radius + 4}px` : "var(--radius-card)",
    "--pv-radius-control": typeof withDerived.radiusControl === "number" ? `${withDerived.radiusControl}px`
      : typeof withDerived.radius === "number" ? `${Math.max(0, withDerived.radius - 2)}px` : "var(--radius-control)",
    "--pv-bg": String(withDerived.background ?? "var(--background)"),
    "--pv-card": String(withDerived.card ?? "var(--card)"),
    "--pv-text": String(withDerived.foreground ?? "var(--foreground)"),
    "--pv-muted": String(withDerived.muted ?? "var(--muted)"),
    "--pv-muted-fg": String(withDerived.mutedForeground ?? "var(--muted-foreground)"),
    "--pv-border": String(withDerived.border ?? "var(--border)"),
    "--pv-secondary": String(withDerived.secondary ?? "var(--secondary)"),
    "--pv-destructive": String(withDerived.destructive ?? "var(--destructive)"),
    "--pv-radius": typeof withDerived.radius === "number" ? `${withDerived.radius}px` : "var(--radius)",
    "--pv-font": String(withDerived.fontFamily ?? "var(--app-font-family)"),
    "--pv-heading": String(withDerived.headingFont ?? withDerived.fontFamily ?? "var(--app-heading-font)"),
    "--pv-heading-weight": String(withDerived.headingWeight ?? "var(--font-weight-heading)"),
    "--pv-heading-size": String(withDerived.textH2 ?? "var(--text-h2)"),
    "--pv-label-tracking": String(withDerived.labelTracking ?? "var(--tracking-label)"),
    "--pv-label-case": String(withDerived.labelCase ?? "var(--label-transform)"),
    "--pv-success": String(withDerived.success ?? "var(--success)"),
    "--pv-success-fg": String(withDerived.successForeground ?? "var(--success-foreground)"),
    "--pv-warning": String(withDerived.warning ?? "var(--warning)"),
    "--pv-warning-fg": String(withDerived.warningForeground ?? "var(--warning-foreground)"),
    "--pv-info": String(withDerived.info ?? "var(--info)"),
    "--pv-info-fg": String(withDerived.infoForeground ?? "var(--info-foreground)"),
    "--pv-destructive-fg": String(withDerived.destructiveForeground ?? "var(--destructive-foreground)"),
  } as CSSProperties;

  return (
    <div className="space-y-6">
      {/* Whose look this is */}
      <section className="rounded-lg border border-border/50 bg-card/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {customized ? <Laptop className="h-4 w-4" /> : <Globe className="h-4 w-4" />}
              {customized ? "Customized in this browser" : hasInstance ? "Following the instance default" : "Built-in default"}
            </div>
            <p className="mt-0.5 text-caption text-muted-foreground">
              The instance default is what everyone sees. Changes below apply to this browser only, until you save them as the instance default.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={customized ? "browser" : "instance"}
              options={[{ value: "instance", label: "Use instance default", icon: Globe }, { value: "browser", label: "Customize for this browser", icon: Laptop }]}
              onChange={(v) => (v === "instance" ? followInstanceDefault() : customizeInBrowser())}
            />
            <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => void save(appearanceAsInstanceDefault(resolved))}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save as instance default
            </Button>
            {hasInstance && (
              <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={busy} onClick={() => void save(null)}>
                <RotateCcw className="h-3.5 w-3.5" /> Clear instance default
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* Theme */}
      <section>
        <h3 className="text-label mb-2 flex items-center gap-1.5 text-muted-foreground">
          <Sun className="h-3.5 w-3.5" /> Theme
          {resolved.sources.theme !== "browser" && <Badge variant="outline" className="ml-1 text-micro">{resolved.sources.theme}</Badge>}
        </h3>
        <Segmented
          value={resolved.theme}
          options={[{ value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }, { value: "system", label: "System", icon: Laptop }]}
          onChange={(v) => setBrowserChoice("theme", v)}
        />
      </section>

      {/* Palette */}
      <section>
        <h3 className="text-label mb-2 flex items-center gap-1.5 text-muted-foreground">
          <PaletteIcon className="h-3.5 w-3.5" /> Palette
          {resolved.sources.palette !== "browser" && <Badge variant="outline" className="ml-1 text-micro">{resolved.sources.palette}</Badge>}
        </h3>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {PALETTES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setBrowserChoice("palette", option.id as Palette)}
              className={cn("rounded-lg border p-3 text-left transition-colors",
                resolved.palette === option.id ? "border-primary/60 bg-primary/5" : "border-border/40 bg-card/60 hover:border-border/70 hover:bg-accent/25")}
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{option.name}</span>
                {resolved.palette === option.id && <Check className="h-3.5 w-3.5 text-primary" />}
              </div>
              <div className="mb-2 flex h-5 overflow-hidden rounded-md border border-border/30">
                {(resolved.dark ? option.swatchDark : option.swatchLight).map((color, index) => (
                  <span key={index} className="flex-1" style={{ background: color }} />
                ))}
              </div>
              <p className="text-caption leading-snug text-muted-foreground">{option.blurb}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Design tokens */}
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-label flex items-center gap-1.5 text-muted-foreground">
            Design tokens
            {resolved.sources.custom !== "browser" && <Badge variant="outline" className="ml-1 text-micro">{resolved.sources.custom}</Badge>}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented value={custom.enabled ? "on" : "off"} options={[{ value: "off", label: "Off" }, { value: "on", label: "On" }]}
              onChange={(v) => setCustom({ ...custom, enabled: v === "on" })} />
            <label className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={custom.derive} onChange={(e) => setCustom({ ...custom, derive: e.target.checked })} />
              Derive the rest
            </label>
            <Segmented value={mode} options={[{ value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }]} onChange={setMode} />
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={exportJson}><Download className="h-3.5 w-3.5" /> Export</Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setImportOpen((o) => !o)}><Upload className="h-3.5 w-3.5" /> Import</Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCustom({ enabled: false, derive: true, light: {}, dark: {} })}>
              <RotateCcw className="h-3.5 w-3.5" /> Reset all
            </Button>
          </div>
        </div>

        {importOpen && (
          <div className="mb-3 space-y-2 rounded-lg border border-border/50 bg-card/50 p-3">
            <Textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={6}
              placeholder={'{ "theme": "dark", "palette": "claude", "custom": { "enabled": true, "light": { "primary": "#c96442" }, "dark": {} } }'}
              className="font-mono text-caption" />
            <div className="flex gap-2">
              <Button size="sm" className="h-8 text-xs" onClick={() => importJson(importText)}>Import</Button>
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => fileInput.current?.click()}>From a file…</Button>
              <input ref={fileInput} type="file" accept="application/json,.json" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(importJson); e.target.value = ""; }} />
            </div>
          </div>
        )}

        <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]", !custom.enabled && "opacity-60")}>
          <div className="space-y-3">
            {GROUPS.map((group) => {
              const names = Object.keys(kit.TOKENS).filter((n) => kit.TOKENS[n][1] === group.id);
              const set = names.filter((n) => tokens[n] !== undefined).length;
              return (
                <div key={group.id} className="rounded-lg border border-border/40 bg-card/60 p-3">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <div>
                      <span className="text-xs font-semibold">{group.label}</span>
                      <span className="ml-2 text-micro text-muted-foreground">{group.hint}{set ? ` · ${set} set` : ""}</span>
                    </div>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-micro" disabled={!set} onClick={() => resetGroup(group.id)}>
                      Reset group
                    </Button>
                  </div>
                  {names.map((name) => {
                    const v = tokens[name];
                    if (kit.TOKENS[name][2] === "gradient") {
                      return <GradientRow key={`${mode}-${name}`} value={typeof v === "object" ? v : undefined}
                        computed={computed("--primary")} onChange={(value) => setToken(name, value)} />;
                    }
                    const d = withDerived[name];
                    return (
                      <TokenRow key={`${mode}-${name}`} name={name} value={typeof v === "object" ? undefined : v}
                        derived={v === undefined && typeof d !== "object" ? d : undefined}
                        computed={computed(kit.TOKENS[name][0])}
                        webFonts={webFonts}
                        onChange={(value) => setToken(name, value)} />
                    );
                  })}
                  {group.id === "typography" && (
                    <WebFonts fonts={webFonts} onChange={setWebFonts}
                      onUse={(family) => setToken("fontFamily", `"${family}", ui-sans-serif, system-ui, sans-serif`)} />
                  )}
                </div>
              );
            })}
          </div>

          <div className="h-fit rounded-lg border border-border/40 bg-card/60 p-4 lg:sticky lg:top-4" style={previewStyle}>
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold">Preview</span>
              <Badge variant="outline" className="text-micro">{mode}</Badge>
            </div>
            <div className="space-y-3 rounded-[var(--pv-radius)] border p-3"
              style={{ background: "var(--pv-bg)", borderColor: "var(--pv-border)", color: "var(--pv-text)", fontFamily: "var(--pv-font)" }}>
              <div className="text-micro font-semibold" style={{ letterSpacing: "var(--pv-label-tracking)", textTransform: "var(--pv-label-case)" as CSSProperties["textTransform"] }}>Label</div>
              <div style={{ fontFamily: "var(--pv-heading)", fontWeight: "var(--pv-heading-weight)" as CSSProperties["fontWeight"], fontSize: "var(--pv-heading-size)" }}>Heading</div>
              <button type="button" className="h-9 w-full rounded-[var(--pv-radius-control)] px-3 text-sm font-medium"
                style={{ background: "var(--pv-button)", color: "var(--pv-button-fg)" }}>Primary action</button>
              <div className="rounded-[var(--pv-radius-card)] border p-3 text-xs" style={{ background: "var(--pv-card)", borderColor: "var(--pv-border)" }}>
                Card surface
                <div className="mt-1" style={{ color: "var(--pv-muted-fg)" }}>Muted text</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--pv-secondary)" }}>Secondary</span>
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--pv-success)", color: "var(--pv-success-fg)" }}>Done</span>
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--pv-warning)", color: "var(--pv-warning-fg)" }}>Waiting</span>
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--pv-info)", color: "var(--pv-info-fg)" }}>Running</span>
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--pv-destructive)", color: "var(--pv-destructive-fg)" }}>Error</span>
              </div>
              <div className="flex h-4 overflow-hidden rounded">
                {["chart1", "chart2", "chart3", "chart4", "chart5"].map((c, i) => (
                  <span key={c} className="flex-1" style={{ background: String(withDerived[c] ?? `var(--chart-${i + 1})`) }} />
                ))}
              </div>
            </div>
            <p className="mt-2 text-micro text-muted-foreground">The whole page is the live preview: changes apply as you make them.</p>
          </div>
        </div>
      </section>
    </div>
  );
}
