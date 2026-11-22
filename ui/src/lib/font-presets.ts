/** The font stacks the appearance editor offers for the typography tokens. */
export const FONT_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Satoshi", value: "\"Satoshi\", ui-sans-serif, system-ui, sans-serif" },
  { label: "System", value: "ui-sans-serif, system-ui, sans-serif" },
  { label: "Inter", value: "\"Inter\", ui-sans-serif, system-ui, sans-serif" },
  /** Bundled (public/fonts): loaded only when a look uses it. */
  { label: "Inter Tight", value: "\"Inter Tight\", ui-sans-serif, system-ui, sans-serif" },
  { label: "IBM Plex Sans", value: "\"IBM Plex Sans\", ui-sans-serif, system-ui, sans-serif" },
  { label: "Newsreader", value: "\"Newsreader\", Georgia, serif" },
  { label: "Serif", value: "ui-serif, Georgia, Cambria, \"Times New Roman\", Times, serif" },
  { label: "Mono", value: "\"JetBrains Mono\", ui-monospace, \"Cascadia Code\", monospace" },
];
