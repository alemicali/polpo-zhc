import type { ReactNode } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CalendarDays,
  CaseSensitive,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Euro,
  Grid2X2,
  Italic,
  PaintBucket,
  Percent,
  RemoveFormatting,
  Underline,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { MAX_CELL_DECIMALS, type CellStyle } from "./artifact-sheets-model";

const textStyles = [
  { key: "bold", label: "Bold", icon: Bold },
  { key: "italic", label: "Italic", icon: Italic },
  { key: "underline", label: "Underline", icon: Underline },
] as const;

const alignments = [
  { value: "left", label: "Align left", icon: AlignLeft },
  { value: "center", label: "Align center", icon: AlignCenter },
  { value: "right", label: "Align right", icon: AlignRight },
] as const;

const palettes = [
  { key: "color", label: "Text color", icon: CaseSensitive, colors: [
    ["Ink", "#111827"], ["White", "#FFFFFF"], ["Ocean", "#0369A1"],
    ["Teal", "#0F766E"], ["Amber", "#B45309"], ["Red", "#B91C1C"], ["Violet", "#7E22CE"],
  ] },
  { key: "fill", label: "Cell color", icon: PaintBucket, colors: [
    ["Graphite", "#1F2937"], ["White", "#FFFFFF"], ["Sky", "#DBEAFE"],
    ["Mint", "#CCFBF1"], ["Sand", "#FEF3C7"], ["Rose", "#FCE7F3"], ["Lavender", "#EDE9FE"],
  ] },
] as const;

const numberFormats = [
  { value: "currency", label: "Euro currency", icon: Euro },
  { value: "percent", label: "Percent", icon: Percent },
  { value: "date", label: "Date", icon: CalendarDays },
] as const;

const borders = [
  { label: "All borders", value: "all" }, { label: "Top border", value: "top" },
  { label: "Bottom border", value: "bottom" }, { label: "Left border", value: "left" }, { label: "Right border", value: "right" },
] as const;

const fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36];

export function SheetFormatBar({ style, onChange, onClear, children }: {
  style: CellStyle;
  onChange: (patch: Partial<CellStyle>) => void;
  onClear: () => void;
  children?: ReactNode;
}) {
  const decimals = style.decimals ?? (style.numberFormat && style.numberFormat !== "date" ? 2 : 0);
  return (
    <div role="group" aria-label="Cell formatting" className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card px-3 py-1.5">
      <div className="flex items-center gap-0.5 border-r border-border pr-1.5">
        {textStyles.map(({ key, label, icon: Icon }) => (
          <Button key={key} type="button" size="icon-xs" variant={style[key] ? "secondary" : "ghost"}
            title={label} aria-label={label} aria-pressed={Boolean(style[key])}
            onClick={() => onChange({ [key]: style[key] ? undefined : true })}><Icon aria-hidden="true" /></Button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="xs" variant={style.fontSize ? "secondary" : "ghost"} aria-label="Font size" title="Font size">
              {style.fontSize ?? 12}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => onChange({ fontSize: undefined })}>Default size</DropdownMenuItem>
            {fontSizes.map((fontSize) => <DropdownMenuItem key={fontSize} onSelect={() => onChange({ fontSize })}>{fontSize}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-0.5 border-r border-border pr-1.5">
        {alignments.map(({ value, label, icon: Icon }) => (
          <Button key={value} type="button" size="icon-xs" variant={style.align === value ? "secondary" : "ghost"}
            title={label} aria-label={label} aria-pressed={style.align === value}
            onClick={() => onChange({ align: style.align === value ? undefined : value })}><Icon aria-hidden="true" /></Button>
        ))}
      </div>
      <div className="flex items-center gap-0.5 border-r border-border pr-1.5">
        {palettes.map(({ key, label, icon: Icon, colors }) => (
          <DropdownMenu key={key}>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon-xs" variant={style[key] ? "secondary" : "ghost"} title={label} aria-label={label}>
                <Icon aria-hidden="true" style={{ color: style[key] }} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onChange({ [key]: undefined })}>Default</DropdownMenuItem>
              {colors.map(([name, color]) => (
                <DropdownMenuItem key={color} onSelect={() => onChange({ [key]: color })}>
                  <span aria-hidden="true" className="size-3.5 rounded-sm border border-border" style={{ backgroundColor: color }} />
                  {name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="icon-xs" variant={style.border ? "secondary" : "ghost"} aria-label="Borders" title="Borders">
              <Grid2X2 aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => onChange({ border: undefined })}>No borders</DropdownMenuItem>
            {borders.map(({ label, value }) => <DropdownMenuItem key={value} onSelect={() => onChange({ border: value })}>{label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex items-center gap-0.5 border-r border-border pr-1.5">
        {numberFormats.map(({ value, label, icon: Icon }) => (
          <Button key={value} type="button" size="icon-xs" variant={style.numberFormat === value ? "secondary" : "ghost"}
            title={label} aria-label={label} aria-pressed={style.numberFormat === value}
            onClick={() => onChange({ numberFormat: style.numberFormat === value ? undefined : value })}><Icon aria-hidden="true" /></Button>
        ))}
        <Button type="button" size="icon-xs" variant="ghost" title="Increase decimals" aria-label="Increase decimals"
          disabled={decimals >= MAX_CELL_DECIMALS || style.numberFormat === "date"} onClick={() => onChange({ decimals: decimals + 1 })}><DecimalsArrowLeft aria-hidden="true" /></Button>
        <Button type="button" size="icon-xs" variant="ghost" title="Decrease decimals" aria-label="Decrease decimals"
          disabled={style.decimals === 0 || style.numberFormat === "date"} onClick={() => onChange({ decimals: Math.max(0, decimals - 1) })}><DecimalsArrowRight aria-hidden="true" /></Button>
      </div>
      <Button type="button" size="icon-xs" variant="ghost" title="Clear formatting" aria-label="Clear formatting"
        disabled={!Object.keys(style).length} onClick={onClear}><RemoveFormatting aria-hidden="true" /></Button>
      {children && <div className="flex shrink-0 items-center border-l border-border pl-1.5">{children}</div>}
    </div>
  );
}
