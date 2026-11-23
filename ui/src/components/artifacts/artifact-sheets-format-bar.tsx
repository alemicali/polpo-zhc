import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CaseSensitive,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  Euro,
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
] as const;

export function SheetFormatBar({ style, onChange, onClear }: {
  style: CellStyle;
  onChange: (patch: Partial<CellStyle>) => void;
  onClear: () => void;
}) {
  const decimals = style.decimals ?? (style.numberFormat ? 2 : 0);
  return (
    <div role="group" aria-label="Cell formatting" className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card px-3 py-1.5">
      <div className="flex items-center gap-0.5 border-r border-border pr-1.5">
        {textStyles.map(({ key, label, icon: Icon }) => (
          <Button key={key} type="button" size="icon-xs" variant={style[key] ? "secondary" : "ghost"}
            title={label} aria-label={label} aria-pressed={Boolean(style[key])}
            onClick={() => onChange({ [key]: style[key] ? undefined : true })}><Icon aria-hidden="true" /></Button>
        ))}
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
      </div>
      <div className="flex items-center gap-0.5 border-r border-border pr-1.5">
        {numberFormats.map(({ value, label, icon: Icon }) => (
          <Button key={value} type="button" size="icon-xs" variant={style.numberFormat === value ? "secondary" : "ghost"}
            title={label} aria-label={label} aria-pressed={style.numberFormat === value}
            onClick={() => onChange({ numberFormat: style.numberFormat === value ? undefined : value })}><Icon aria-hidden="true" /></Button>
        ))}
        <Button type="button" size="icon-xs" variant="ghost" title="Increase decimals" aria-label="Increase decimals"
          disabled={decimals >= MAX_CELL_DECIMALS} onClick={() => onChange({ decimals: decimals + 1 })}><DecimalsArrowLeft aria-hidden="true" /></Button>
        <Button type="button" size="icon-xs" variant="ghost" title="Decrease decimals" aria-label="Decrease decimals"
          disabled={style.decimals === 0} onClick={() => onChange({ decimals: Math.max(0, decimals - 1) })}><DecimalsArrowRight aria-hidden="true" /></Button>
      </div>
      <Button type="button" size="icon-xs" variant="ghost" title="Clear formatting" aria-label="Clear formatting"
        disabled={!Object.keys(style).length} onClick={onClear}><RemoveFormatting aria-hidden="true" /></Button>
    </div>
  );
}
