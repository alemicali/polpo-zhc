# Appearance

The dashboard's look has three layers, resolved field by field (theme, palette, custom design tokens):

1. **This browser's choice** — what a person picks in Configuration → Appearance, the header's theme toggle or the palette menu (saved in the browser, per API and instance);
2. **the instance default** — `settings.appearance` in `.polpo/polpo.json`, set by "Save as instance default" in Configuration → Appearance, `PATCH /api/v1/config/settings { appearance }` or MCP `polpo_branding_update`;
3. **the built-in default** — dark, Tide Pool palette, no custom tokens.

"Use instance default" drops this browser's choices; "Customize for this browser" keeps the current look as its own. Saving as the instance default makes the current look everyone's and drops this browser's own choices.

Every member can edit Configuration (members have no roles), so every member sees "Save as instance default". Through MCP the change needs the `polpo:admin` scope.

## settings.appearance

```json
{
  "settings": {
    "appearance": {
      "theme": "light",
      "palette": "claude",
      "custom": {
        "enabled": true,
        "derive": true,
        "light": { "primary": "#c96442", "background": "oklch(0.98 0.01 80)", "fontFamily": "\"Inter\", sans-serif", "radius": 10 },
        "dark": { "primary": "hsl(18 70% 62%)" }
      }
    }
  }
}
```

- `theme`: `light`, `dark` or `system`.
- `palette`: `tide`, `lovable`, `chatgpt`, `claude`, `brutal`, `editorial`, `redline`, `cyber`, `mono`.
- `custom.light` / `custom.dark`: any subset of the tokens below. A token not given keeps the palette's value.
- `custom.derive` (default `true`): fill the tokens not given from those given (see Derivation).

Values are checked by the REST route and MCP, which refuse invalid input (400), and by the config loader, which ignores the invalid part of a hand-edited `polpo.json` with a warning in the log (the rest applies; the instance always starts):

- **colours**: `#rgb`, `#rrggbb`, `#rrggbbaa`, `oklch(…)`, `oklab(…)`, `lab(…)`, `lch(…)`, `hsl(…)`, `rgb(…)` (the syntaxes the dashboard's CSS uses);
- **fonts**: a CSS font stack of names, commas and quotes, at most 200 characters (no `;`, braces, `url(`…). The dashboard loads Satoshi, IBM Plex Sans, JetBrains Mono and Newsreader, and ships **Inter Tight** (self-hosted variable woff2, weights 100–900, latin + latin-ext, `font-display: swap`: fetched only when a look uses it, and preloaded by the inline script then; e.g. `"\"Inter Tight\", sans-serif"`); other families need to be installed on the viewer's device (no web-font loading);
- **radius**: 0–24 px;
- **shadows**: a `box-shadow` or `none`, no `url(`.

The old shape (`primary`, `secondary`, `text`, `fontFamily`, `radius` per mode) is still read: `text` is `foreground`.

The dark-mode logo is part of the branding: `settings.branding.logoDarkUrl` (an https URL or the managed `/api/v1/config/branding/logo-dark`, uploaded with `POST /api/v1/config/instance-logo?variant=dark`), shown in dark mode; the logo is used when it is missing or fails to load. The favicon is always Polpo's.

`settings.branding.logoFrame` says how the logo is shown everywhere (sidebar, header, mobile nav, sign-in): `"box"` (the default) in a tile, `"none"` bare (the same height, its own width, no background, border or padding). Configuration → Appearance → "Show logo in a box"; MCP `polpo_branding_update { logo_frame: "box" | "none" | null }`; REST `PATCH /api/v1/config/settings { branding: { logoFrame } }` (`""` restores the default).

## Design tokens: before and after

Every CSS custom property the dashboard's theme uses (`ui/src/index.css`), and whether an appearance can set it.

| Group | Token (`settings.appearance.custom.*`) | CSS property | Before (per browser only) | Now (instance default and per browser) |
|---|---|---|---|---|
| Brand | `primary` | `--primary` | yes | yes |
| Brand | `secondary` | `--secondary` | yes | yes |
| Brand | `accent` | `--accent` | only as a copy of secondary | yes (derived from secondary) |
| Surfaces | `background` | `--background` | palette only | yes |
| Surfaces | `card` | `--card` | palette only | yes (derived from background) |
| Surfaces | `popover` | `--popover` | palette only | yes (derived from card) |
| Surfaces | `muted` | `--muted` | palette only | yes |
| Text | `foreground` | `--foreground` | yes (`text`) | yes |
| Text | `mutedForeground` | `--muted-foreground` | palette only | yes |
| Text | `cardForeground`, `popoverForeground` | `--card-foreground`, `--popover-foreground` | copies of text | yes (derived from foreground) |
| Text | `primaryForeground`, `secondaryForeground`, `accentForeground` | `--*-foreground` | contrast of hex only | yes (derived by contrast, any colour syntax) |
| Borders & focus | `border`, `input` | `--border`, `--input` | palette only | yes (input derived from border) |
| Borders & focus | `ring` | `--ring` | copy of primary | yes (derived from primary) |
| Sidebar | `sidebar`, `sidebarForeground`, `sidebarPrimary`, `sidebarPrimaryForeground`, `sidebarAccent`, `sidebarAccentForeground`, `sidebarBorder`, `sidebarRing` | `--sidebar*` | primary and foreground copies only | yes (derived from background, foreground, primary, accent, border) |
| Charts | `chart1` … `chart5` | `--chart-1` … `--chart-5` | palette only | yes (chart1 derived from primary) |
| Status | `destructive` | `--destructive` | palette only | yes |
| Typography | `fontFamily` | `--app-font-family`, `--font-sans` | yes | yes (also on palettes that set their own body font) |
| Typography | `headingFont` | `--app-heading-font` (h1–h3) | palette only (Claude, Redline) | yes |
| Typography | `monoFont` | `--app-mono-font` (code, pre) | no (fixed JetBrains Mono) | yes |
| Shape | `radius` | `--radius` (and `--radius-sm` … `--radius-4xl`) | yes | yes (Redline forces square corners) |
| Shape | `shadowCard` | `--shadow-card` | palette only | yes (applied to every card) |
| Shape | `shadowRaised` | `--shadow-raised` | palette only | yes |

Not configurable: success / warning / info colours (the components use Tailwind's emerald, amber and sky directly, not tokens), palette-only textures (Editorial's paper grain, Cyber's glow), spacing and density (no density tokens exist), and the favicon.

## Derivation

With `derive` on, a token not given is filled from one that is, in this order: `accent` ← `secondary`; `card` ← `background`; `popover` ← `card`; `sidebar` ← `background`; `cardForeground`, `popoverForeground`, `sidebarForeground` ← `foreground`; `primaryForeground`, `secondaryForeground`, `accentForeground`, `sidebarPrimaryForeground`, `sidebarAccentForeground` ← a readable black or white on their surface; `ring`, `sidebarPrimary`, `chart1` ← `primary`; `input`, `sidebarBorder` ← `border`; `sidebarAccent` ← `accent`; `sidebarRing` ← `sidebarPrimary`. A token given always wins.

## No flash on reload

The first frame already has the right look:

- `ui/server.mjs` reads the instance default from the API's public `GET /api/v1/config/appearance` (at most every 30 s, 1.5 s timeout; `POLPO_APPEARANCE_URL` / `POLPO_APPEARANCE_TTL_MS` override) and inlines it into `/runtime-config.js`;
- `index.html` runs a small inline script right after `/runtime-config.js`, before the stylesheet: it resolves the three layers (this browser's choices are read under the instance it saw last on this API) and sets the `dark` class, `data-palette`, the overrides stylesheet and `<meta name="theme-color">`. The script is `ui/src/lib/appearance-kit.ts`, inlined at build time by `vite.config.ts`; the app uses the same code after it loads.

Without `runtime-config.js` (the Electron app, the nginx image) the script uses the instance default cached by the last visit; without anything, the built-in default.

The branding the same way: `ui/server.mjs` also reads the public `GET /api/v1/config/branding` (display fields only: `productName`, `tagline`, `logoUrl`, `logoDarkUrl`, `logoFrame`; `POLPO_BRANDING_URL` overrides, else next to `POLPO_APPEARANCE_URL`), inlines it into `/runtime-config.js` and puts the product name in `index.html`'s `<title>`. The inline script sets the title and adds a `<link rel="preload" as="image">` for the logo of the theme just applied (the dark one in dark mode); the app reads the branding synchronously on its first render (`ui/src/lib/branding.ts`, falling back to the copy cached in this browser), so neither the name nor the logo shows Polpo's first. The browser tab is the product name, then ` · <page>` (without a product name: `Polpo ZHC — AI Factory`).
