import type { ReactNode } from "react";
import {
  AlignCenter, AlignLeft, AlignRight, Bold, CaseSensitive, ChevronDown,
  DecimalsArrowLeft, DecimalsArrowRight, Euro, Grid2X2, Italic, PaintBucket,
  Percent, RemoveFormatting, Underline,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SHEET_FILL_COLORS, SHEET_TEXT_COLORS } from "./artifact-content-palette";
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
  { key: "color", label: "Text color", icon: CaseSensitive, colors: SHEET_TEXT_COLORS },
  { key: "fill", label: "Cell color", icon: PaintBucket, colors: SHEET_FILL_COLORS },
] as const;

const borders = [
  { label: "All borders", value: "all" }, { label: "Top border", value: "top" },
  { label: "Bottom border", value: "bottom" }, { label: "Left border", value: "left" }, { label: "Right border", value: "right" },
] as const;

const fontSizes = [8, 9, 10, 11, 12, 14, 16, 18, 24, 30, 36];
type Formatting = { style: CellStyle; onChange: (patch: Partial<CellStyle>) => void };

export function SheetFormatBar({ style, onChange, children }: Formatting & { children: ReactNode }) {
  const AlignmentIcon = alignments.find(({ value }) => value === style.align)?.icon ?? AlignLeft;
  return (
    <div role="group" aria-label="Formatting" data-slot="sheet-formatting-dock"
      className="absolute bottom-4 left-1/2 z-30 flex h-7 max-w-[calc(100%-1rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-control border border-border bg-popover px-1 shadow-raised [scrollbar-width:none]">
      <div className="flex items-center gap-1 border-r border-border pr-1">
        {textStyles.map(({ key, label, icon: Icon }) => (
          <Button key={key} type="button" size="icon-xs" variant={style[key] ? "secondary" : "ghost"}
            title={label} aria-label={label} aria-pressed={Boolean(style[key])}
            onClick={() => onChange({ [key]: style[key] ? undefined : true })}><Icon aria-hidden="true" /></Button>
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="xs" variant={style.align ? "secondary" : "ghost"} title="Align" aria-label="Align">
            <AlignmentIcon aria-hidden="true" /><ChevronDown aria-hidden="true" className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuItem onSelect={() => onChange({ align: undefined })}>Automatic alignment</DropdownMenuItem>
          {alignments.map(({ value, label, icon: Icon }) => <DropdownMenuItem key={value} onSelect={() => onChange({ align: value })}>
            <Icon aria-hidden="true" />{label}
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex items-center gap-1 border-x border-border px-1">
        {palettes.map(({ key, label, icon: Icon, colors }) => (
          <DropdownMenu key={key}>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon-xs" variant={style[key] ? "secondary" : "ghost"} title={label} aria-label={label}>
                <Icon aria-hidden="true" style={{ color: style[key] }} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
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
          <DropdownMenuContent align="start" side="top">
            <DropdownMenuItem onSelect={() => onChange({ border: undefined })}>No borders</DropdownMenuItem>
            {borders.map(({ label, value }) => <DropdownMenuItem key={value} onSelect={() => onChange({ border: value })}>{label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {children}
    </div>
  );
}

export function SheetFontMenu({ style, onChange }: Formatting) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="xs" variant={style.fontSize ? "secondary" : "ghost"} aria-label="Font size" title="Font size">
          {style.fontSize ?? 12}<ChevronDown aria-hidden="true" className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        <DropdownMenuItem onSelect={() => onChange({ fontSize: undefined })}>Default size</DropdownMenuItem>
        {fontSizes.map((fontSize) => <DropdownMenuItem key={fontSize} onSelect={() => onChange({ fontSize })}>{fontSize}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SheetFormattingMenu({ style, onChange, onClear }: Formatting & { onClear: () => void }) {
  const decimals = style.decimals ?? (style.numberFormat && style.numberFormat !== "date" ? 2 : 0);
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>Number format</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onSelect={() => onChange({ numberFormat: undefined, decimals: undefined })}>Automatic number format</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange({ numberFormat: "currency" })}><Euro aria-hidden="true" />Euro currency</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onChange({ numberFormat: "percent" })}><Percent aria-hidden="true" />Percent</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={style.decimals === 0 || style.numberFormat === "date"}
            onSelect={() => onChange({ decimals: Math.max(0, decimals - 1) })}><DecimalsArrowRight aria-hidden="true" />Decrease decimals</DropdownMenuItem>
          <DropdownMenuItem disabled={decimals >= MAX_CELL_DECIMALS || style.numberFormat === "date"}
            onSelect={() => onChange({ decimals: decimals + 1 })}><DecimalsArrowLeft aria-hidden="true" />Increase decimals</DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem onSelect={onClear}><RemoveFormatting aria-hidden="true" />Clear cell formatting</DropdownMenuItem>
    </>
  );
}
