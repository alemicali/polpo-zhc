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
        "dark": { "primary": "hsl(18 70% 62%)", "buttonGradient": { "from": "#7c3aed", "to": "#db2777", "angle": 135 } }
      },
      "fonts": [
        { "family": "Manrope", "source": "google", "weights": "400;600;700" },
        { "family": "Inter Display", "source": "url", "url": "https://rsms.me/inter/inter.css" }
      ]
    }
  }
}
```

- `theme`: `light`, `dark` or `system`.
- `palette`: `tide`, `lovable`, `chatgpt`, `claude`, `brutal`, `editorial`, `redline`, `cyber`, `mono`.
- `custom.light` / `custom.dark`: any subset of the tokens below. A token not given keeps the palette's value.
- `custom.derive` (default `true`): fill the tokens not given from those given (see Derivation).
- `fonts`: web fonts to load, so a font stack can name a family the dashboard does not ship (see Web fonts). At most 8, one per family.

Values are checked by the REST route and MCP, which refuse invalid input (400), and by the config loader, which ignores the invalid part of a hand-edited `polpo.json` with a warning in the log (the rest applies; the instance always starts):

- **colours**: `#rgb`, `#rrggbb`, `#rrggbbaa`, `oklch(…)`, `oklab(…)`, `lab(…)`, `lch(…)`, `hsl(…)`, `rgb(…)` (the syntaxes the dashboard's CSS uses);
- **fonts**: a CSS font stack of names, commas and quotes, at most 200 characters (no `;`, braces, `url(`…). The dashboard loads Satoshi, IBM Plex Sans, JetBrains Mono and Newsreader, and ships **Inter Tight** (self-hosted variable woff2, weights 100–900, latin + latin-ext, `font-display: swap`: fetched only when a look uses it, and preloaded by the inline script then; e.g. `"\"Inter Tight\", sans-serif"`); any other family needs a web font in `fonts` (else it shows only on devices that have it installed; MCP says so: `unloaded_fonts`);
- **radius**: `radius` 0–24 px; `radiusCard`, `radiusControl` 0–32 px;
- **button gradient** (`buttonGradient`): `{ "from": colour, "to": colour, "angle": 0–360 }` (angle default 135), built into `linear-gradient(…)` by the dashboard — no free-form CSS;
- **sidebar**: `sidebarOpacity` 0.5–1, `sidebarBlur` 0–24 px;
- **shadows**: a `box-shadow` or `none`, no `url(`;
- **font sizes** (the type scale): `rem` 0.5–6 or `px` 8–96 (e.g. `"1.75rem"`, `"13px"`);
- **font weight** (`headingWeight`): a number 100–900;
- **letter-spacing** (`headingTracking`, `labelTracking`): `em` -0.1–0.3 or `px` -3–6, `0` or `normal`;
- **label case** (`labelCase`): `uppercase`, `none`, `capitalize` or `lowercase`.

The dashboard loads Satoshi (variable, 300–900), IBM Plex Sans (400–700), Inter (400–700), JetBrains Mono (400–700) and Newsreader (400–700) from their font services (declared only: a family is downloaded when the page uses it) and bundles Inter Tight — every preset in the editor.

The old shape (`primary`, `secondary`, `text`, `fontFamily`, `radius` per mode) is still read: `text` is `foreground`.

## Web fonts

`settings.appearance.fonts` lists the families to load, each `{ family, source, url?, weights? }`:

- `"source": "google"`: Google Fonts by family. `weights` is a list (`"400;600;700"`) or, for a variable font, a range (`"300..800"`); without it only the regular weight is loaded (the browser synthesizes bold). The dashboard builds `https://fonts.googleapis.com/css2?family=<family>:wght@<weights>&display=swap`.
- `"source": "url"`: an https stylesheet on `fonts.googleapis.com`, `fonts.bunny.net`, `use.typekit.net`, `api.fontshare.com` or `rsms.me` (no other host, no `http:`, port or credentials; at most 512 characters); `display=swap` is added for Google, Bunny and Fontshare when missing.
- `family`: the name the stylesheet declares and a font stack uses: letters, digits, spaces, `_` and `-`, up to 64 characters.

Then name the family in `fontFamily`, `headingFont` or `monoFont` (e.g. `"\"Manrope\", sans-serif"`). No web font is needed for Inter Tight (bundled, self-hosted) or for Satoshi, Inter, IBM Plex Sans, JetBrains Mono and Newsreader (declared by `index.html`).

The inline `<head>` script adds, per web font, a `<link rel="preconnect">` to the service (and its font-file host, e.g. `fonts.gstatic.com`) and the `<link rel="stylesheet" blocking="render">`, before the stylesheet paints — like `index.html`'s own font stylesheets — so the first frame knows the family; the files use `font-display: swap`. Fonts no longer listed are removed. In the editor: Configuration → Appearance → Typography → Web fonts ("Add a web font": family, Google Fonts with weights or a stylesheet URL, a live sample, "Use" to set it as the body font). MCP: `polpo_branding_update { fonts: [...] }` (replaces the list; `null` or `[]` removes them); `polpo_branding_get` returns `font_sources` (bundled, preloaded, the allowed hosts).

The UI server (`ui/server.mjs`) and `index.html` set no Content-Security-Policy, so nothing else is needed; a proxy that adds one must allow the hosts above in `style-src` and their font-file hosts (`fonts.gstatic.com`, `fonts.bunny.net`, `use.typekit.net`, `p.typekit.net`, `cdn.fontshare.com`, `rsms.me`) in `font-src`.

The dark-mode logo is part of the branding: `settings.branding.logoDarkUrl` (an https URL or the managed `/api/v1/config/branding/logo-dark`, uploaded with `POST /api/v1/config/instance-logo?variant=dark`), shown in dark mode; the logo is used when it is missing or fails to load. The favicon is always Polpo's.

`settings.branding.logoFrame` says how the logo is shown everywhere (sidebar, header, mobile nav, sign-in): `"box"` (the default) in a tile, `"none"` bare (the same height, its own width, no background, border or padding). Configuration → Appearance → "Show logo in a box"; MCP `polpo_branding_update { logo_frame: "box" | "none" | null }`; REST `PATCH /api/v1/config/settings { branding: { logoFrame } }` (`""` restores the default).

## Design tokens: before and after

Every CSS custom property the dashboard's theme uses (`ui/src/index.css`), and whether an appearance can set it.

| Group | Token (`settings.appearance.custom.*`) | CSS property | Before (per browser only) | Now (instance default and per browser) |
|---|---|---|---|---|
| Brand | `primary` | `--primary` | yes | yes |
| Brand | `secondary` | `--secondary` | yes | yes |
| Brand | `accent` | `--accent` | only as a copy of secondary | yes (derived from secondary) |
| Brand | `buttonPrimaryBg` | `--button-primary-bg` (primary buttons, default badges; hover `--button-primary-hover-bg` = 90%) | no (primary) | yes (default: primary) |
| Brand | `buttonGradient` | `--button-primary-bg` as `linear-gradient(angle, from, to)` (hover: both ends at 90%) | no | yes (wins over `buttonPrimaryBg`) |
| Brand | `buttonPrimaryForeground` | `--button-primary-foreground` | no (primary-foreground) | yes (derived by contrast on the gradient or fill; default primary-foreground) |
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
| Sidebar | `sidebarOpacity`, `sidebarBlur` | `--sidebar-opacity`, `--sidebar-blur` (and `--sidebar-backdrop`: `blur(n px)`, or `none` at 0) | no (opaque) | yes (default 1 and 0: opaque, no backdrop filter) |
| Charts | `chart1` … `chart5` | `--chart-1` … `--chart-5` | palette only | yes (chart1 derived from primary) |
| Status | `destructive` | `--destructive` | palette only | yes |
| Status | `destructiveForeground` | `--destructive-foreground` | no | yes (derived by contrast) |
| Status | `success`, `warning`, `info` | `--success`, `--warning`, `--info` | no (fixed Tailwind emerald / amber / sky) | yes (every palette defines them) |
| Status | `successForeground`, `warningForeground`, `infoForeground` | `--*-foreground` | no | yes (derived by contrast) |
| Status | `statusRunning`, `statusQueued`, `statusAssigned` | `--status-running`, `--status-queued`, `--status-assigned` | no | yes (default: info, muted text, primary) |
| Typography | `fontFamily` | `--app-font-family` (Tailwind `font-sans`) | yes | yes (also on palettes that set their own body font) |
| Typography | `headingFont` | `--app-heading-font` (h1–h3, `font-heading`, card / dialog / sheet titles) | palette only (Claude, Redline) | yes |
| Typography | `monoFont` | `--app-mono-font` (code, pre, kbd, Tailwind `font-mono`) | no (fixed JetBrains Mono) | yes |
| Typography | `textDisplay`, `textH1`, `textH2`, `textH3`, `textBody`, `textSmall`, `textCaption`, `textMicro` | `--text-display` … `--text-micro` | no | yes |
| Typography | `headingWeight` | `--font-weight-heading` | no (fixed 700; Claude 600) | yes |
| Typography | `headingTracking` | `--tracking-heading` | no | yes |
| Typography | `labelTracking`, `labelCase` | `--tracking-label`, `--label-transform` (`text-label`) | no | yes |
| Shape | `radius` | `--radius` (and `--radius-sm` … `--radius-4xl`) | yes | yes (Redline forces square corners) |
| Shape | `radiusCard` | `--radius-card` (`rounded-card`: Card, tiles) | no (`radius` + 4px) | yes (default `radius` + 4px) |
| Shape | `radiusControl` | `--radius-control` (`rounded-control`: buttons, inputs, selects, textareas) | no (`radius` − 2px) | yes (default `radius` − 2px) |
| Shape | `shadowCard` | `--shadow-card` (`shadow-card`: every card) | palette only | yes |
| Shape | `shadowRaised` | `--shadow-raised` (`shadow-raised`: popovers, menus, selects, dialogs, sheets, tooltips, the mobile nav) | palette only | yes |

Not configurable: palette-only textures (Editorial's paper grain, Cyber's scanlines), spacing and density (no density tokens exist), the line heights of the type scale (`--leading-*`, per palette in CSS only), and the favicon. Palettes with zero letter-spacing (Lovable, ChatGPT, Claude, Redline) set `headingTracking` and `labelTracking` to 0; a custom value still applies.

## Using the tokens in the dashboard's code

`ui/src/index.css` maps every token to Tailwind (`@theme`), so screens never need a fixed colour or size:

| Need | Use |
|---|---|
| Success / warning / info / error text | `text-success`, `text-warning`, `text-info`, `text-destructive` |
| Tinted badge or banner | `bg-success/10 text-success border-success/30` (same for warning, info, destructive) |
| Filled badge or button | `bg-success text-success-foreground` (… `bg-destructive text-destructive-foreground`) |
| Task states | `text-status-running` / `bg-status-running`, `…-status-queued`, `…-status-assigned`; done → success, failed → destructive, review / awaiting → warning |
| Page title | `<PageHeader title description actions />` (`components/shared/page-header.tsx`: `font-heading text-h1`) |
| Section title | `<SectionHeader title icon count actions />` (a `text-label`) |
| Small uppercase label | `<Eyebrow>` or the `text-label` class (caption size, 600, label case and tracking) |
| A metric | `<StatValue label value hint tone />` |
| Font sizes | `text-display` (2.25rem), `text-h1` (1.5rem), `text-h2` (1.125rem), `text-h3` (0.9375rem), `text-body` (0.875rem), `text-small` (0.8125rem), `text-caption` (0.6875rem), `text-micro` (0.625rem) |
| Heading font, weight, tracking | `font-heading` |
| Shadows | `shadow-card`, `shadow-raised` |
| Sidebar-like chrome | `bg-sidebar text-sidebar-foreground border-sidebar-border`, hover `bg-sidebar-accent`, active `text-sidebar-primary`; the navigation column itself `sidebar-surface` (opacity and blur), the floating bottom nav `sidebar-surface-floating` |
| Corners | `rounded-card` (cards, tiles), `rounded-control` (buttons, inputs, selects) |
| A primary call to action of your own | `bg-button-primary text-button-primary-foreground hover:bg-button-primary-hover` (follows the button style, gradient included) |

`ui/tests/theme-guard.test.ts` counts, per file, Tailwind palette colours (`bg-emerald-500`, `text-zinc-400`, `bg-white`…), colour literals (`#…`, `rgb(…)`, `oklch(…)`…) and arbitrary sizes (`text-[10px]`) and fails when a file has more than `ui/tests/theme-guard.baseline.json` allows (files not listed: zero). After removing some, lower the baseline: `UPDATE_THEME_BASELINE=1 npx vitest run --config ui/vitest.config.ts ui/tests/theme-guard.test.ts`, and commit it. Real exceptions (vendor brand colours, the QR code, the appearance preview) are in the test's `ALLOWLIST`.

## Derivation

With `derive` on, a token not given is filled from one that is, in this order: `accent` ← `secondary`; `card` ← `background`; `popover` ← `card`; `sidebar` ← `background`; `cardForeground`, `popoverForeground`, `sidebarForeground` ← `foreground`; `primaryForeground`, `secondaryForeground`, `accentForeground`, `sidebarPrimaryForeground`, `sidebarAccentForeground` ← a readable black or white on their surface; `ring`, `sidebarPrimary`, `chart1` ← `primary`; `input`, `sidebarBorder` ← `border`; `sidebarAccent` ← `accent`; `sidebarRing` ← `sidebarPrimary`; `destructiveForeground`, `successForeground`, `warningForeground`, `infoForeground` ← a readable black or white on their colour; `statusRunning` ← `info`; `statusAssigned` ← `primary`; `statusQueued` ← `mutedForeground`; `buttonPrimaryForeground` ← a readable black or white on `buttonGradient` (the average of its two ends), else on `buttonPrimaryBg`. A token given always wins.

Without a value the stylesheet's defaults keep today's look: `--button-primary-bg` is `var(--primary)` (hover 90%, as `bg-primary/90`), `--button-primary-foreground` `var(--primary-foreground)`, `--radius-card` `calc(var(--radius) + 4px)` (rounded-xl), `--radius-control` `calc(var(--radius) - 2px)` (rounded-md), `--sidebar-opacity` 1 and `--sidebar-blur` 0 (opaque, no `backdrop-filter`: any value but `none` would make the sidebar a containing block). Where the browser has no `backdrop-filter` or `color-mix()` the sidebar stays opaque. The bottom nav on phones is already translucent (72%, blurred): `sidebarOpacity` scales it.

## No flash on reload

The first frame already has the right look:

- `ui/server.mjs` reads the instance default from the API's public `GET /api/v1/config/appearance` (at most every 30 s, 1.5 s timeout; `POLPO_APPEARANCE_URL` / `POLPO_APPEARANCE_TTL_MS` override) and inlines it into `/runtime-config.js`;
- `index.html` runs a small inline script right after `/runtime-config.js`, before the stylesheet: it resolves the three layers (this browser's choices are read under the instance it saw last on this API) and sets the `dark` class, `data-palette`, the overrides stylesheet and `<meta name="theme-color">`. The script is `ui/src/lib/appearance-kit.ts`, inlined at build time by `vite.config.ts`; the app uses the same code after it loads.

Without `runtime-config.js` (the Electron app, the nginx image) the script uses the instance default cached by the last visit; without anything, the built-in default.

The branding the same way: `ui/server.mjs` also reads the public `GET /api/v1/config/branding` (display fields only: `productName`, `tagline`, `logoUrl`, `logoDarkUrl`, `logoFrame`; `POLPO_BRANDING_URL` overrides, else next to `POLPO_APPEARANCE_URL`), inlines it into `/runtime-config.js` and puts the product name in `index.html`'s `<title>`. The inline script sets the title and adds a `<link rel="preload" as="image">` for the logo of the theme just applied (the dark one in dark mode); the app reads the branding synchronously on its first render (`ui/src/lib/branding.ts`, falling back to the copy cached in this browser), so neither the name nor the logo shows Polpo's first. The browser tab is the product name, then ` · <page>` (without a product name: `Polpo ZHC — AI Factory`).
