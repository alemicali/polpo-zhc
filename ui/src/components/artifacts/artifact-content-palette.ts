/**
 * The artifact workspaces' CONTENT palette: colours and sizes that belong to a user's document, not
 * to the dashboard.
 *
 * Everything the software draws (toolbars, panels, inspectors, the gallery, comments, chips'
 * chrome, selection outlines, the live chart preview…) takes its look from the theme tokens, like
 * every other screen (docs/appearance.md, "Nothing fixed"). What is here is user data instead:
 *
 * - the default colours offered in the content pickers (text and cell colours of a sheet, the
 *   conditional-format fill, the slide themes, a new design shape or note, a new motion layer, a
 *   freehand stroke): once picked they are written into the document and must stay what the user
 *   chose, whatever look the dashboard has, on every device and in every export;
 * - the literal colours and sizes written into exported files (.docx / .xlsx / .pptx / the print
 *   view / the rendered video) and into a new document's own markup (a blank design artboard), which
 *   leave the dashboard and cannot follow its CSS variables.
 *
 * This is the only artifact file the theme guard allows literal values in (ui/tests/theme-guard.test.ts
 * ALLOWLIST). Keep chrome out of it: a colour that only the dashboard shows belongs to a token.
 */

/** Colours of a doc's choice chips (status, priority…): ids stored in the document. */
export const DOC_CHOICE_COLORS = ["slate", "blue", "green", "amber", "rose", "violet"] as const;
export type DocChoiceColor = typeof DOC_CHOICE_COLORS[number];

/** The ready-made choice lists a doc offers (Status, Priority). */
export const DOC_CHOICE_TEMPLATES: Array<{ id: string; name: string; options: Array<{ id: string; label: string; color: DocChoiceColor }> }> = [
  {
    id: "status",
    name: "Status",
    options: [
      { id: "todo", label: "Not started", color: "slate" },
      { id: "doing", label: "In progress", color: "blue" },
      { id: "done", label: "Done", color: "green" },
    ],
  },
  {
    id: "priority",
    name: "Priority",
    options: [
      { id: "low", label: "Low", color: "blue" },
      { id: "medium", label: "Medium", color: "amber" },
      { id: "high", label: "High", color: "rose" },
    ],
  },
];

/** The print view's stylesheet (a separate window, printed to paper or PDF: it cannot use the theme). */
export const DOC_PRINT_STYLES = `
  @page { margin: 18mm; }
  body { color: #182033; max-width: 760px; margin: 24px auto; padding: 0 1rem; font: 12pt/1.55 system-ui, sans-serif; }
  h1,h2,h3,h4,h5,h6 { line-height: 1.2; break-after: avoid; }
  p { orphans: 3; widows: 3; }
  img, video { max-width: 100%; max-height: 70vh; }
  video { display: none; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  thead { display: table-header-group; }
  th,td { text-align: left; padding: .4em; border: 1px solid #cbd5e1; }
  th, pre { background: #f1f5f9; }
  pre { padding: .8em; white-space: pre-wrap; overflow-wrap: anywhere; }
  blockquote { margin-left: 0; padding-left: 1em; border-left: 2px solid #cbd5e1; }
  blockquote[data-alert]::before { content: attr(data-alert); display: block; font-weight: 650; }
  ul[data-type="taskList"] { list-style: none; padding-left: 1.2em; }
  li[data-type="taskItem"] { display: flex; gap: .5em; }
  li p { margin: 0; }
  details { margin: 1em 0; }
  [data-polpo-doc-choice] { border: 1px solid #cbd5e1; border-radius: 9999px; padding: .05em .45em; }
  [data-polpo-doc-font="sans"] { font-family: system-ui, sans-serif; }
  [data-polpo-doc-font="serif"] { font-family: Georgia, serif; }
  [data-polpo-doc-font="mono"] { font-family: ui-monospace, monospace; }
  @media print {
    body { margin: 0; padding: 0; }
    section[data-doc-tab] + section[data-doc-tab] { break-before: page; }
  }
`;

/** A sheet's text and cell colours offered in the format bar. */
export const SHEET_TEXT_COLORS = [
  ["Ink", "#111827"], ["White", "#FFFFFF"], ["Ocean", "#0369A1"],
  ["Teal", "#0F766E"], ["Amber", "#B45309"], ["Red", "#B91C1C"], ["Violet", "#7E22CE"],
] as const;
export const SHEET_FILL_COLORS = [
  ["Graphite", "#1F2937"], ["White", "#FFFFFF"], ["Sky", "#DBEAFE"],
  ["Mint", "#CCFBF1"], ["Sand", "#FEF3C7"], ["Rose", "#FCE7F3"], ["Lavender", "#EDE9FE"],
] as const;
/** The default fill of a new conditional-format rule. */
export const SHEET_RULE_FILL = "#CCFBF1";
/** The cell border written into an exported .xlsx (ARGB). */
export const SHEET_EXPORT_BORDER_ARGB = "FF64748B";

/** A slide's theme: page, text and accent colours (shown in the editor and written into the .pptx). */
export const SLIDE_THEMES = {
  light: { bg: "#f7f7ef", fg: "#182d29", accent: "#3c7968" },
  dark: { bg: "#182d29", fg: "#f7f7ef", accent: "#b6e1cd" },
  accent: { bg: "#d1ece1", fg: "#182d29", accent: "#265c50" },
} as const;
/** Slide text: line heights and the font sizes of fixed fields, in % of the slide's width (cqw). */
export const SLIDE_TEXT = { lineHeight: 1.2, tableLineHeight: 1.15, columnSize: 2.6, accentBarSize: 1 } as const;

/** A new design artboard's own stylesheet (inside the user's HTML). */
export const DESIGN_BLANK_BOARD_STYLE = "*{box-sizing:border-box}body{margin:0;background:white;color:#202124;font:16px system-ui,sans-serif}";
/** New design elements: a sticky note, a shape, a freehand stroke. */
export const DESIGN_NOTE = { background: "#fff2bd", color: "#342608" } as const;
export const DESIGN_SHAPE_FILL = "#6186b4";
export const DESIGN_STROKE = "#416a9b";
/** Example values shown in the design inspector's empty colour fields. */
export const DESIGN_COLOR_PLACEHOLDERS = { color: "#192620", background: "#f2f0ea" } as const;

/** A new motion project's scene background and a new layer's colour (rendered into the video). */
export const MOTION_SCENE_BACKGROUND = "#ffffff";
export const MOTION_LAYER_COLOR = "#f6faf7";
