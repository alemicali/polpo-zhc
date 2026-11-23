import type { SlideElement } from "./artifact-slides-format";
import { slideTableFontSize } from "./artifact-slides-format";

export function SlideTable({ element, colors, onChange, onSelect }: {
  element: SlideElement;
  colors: { bg: string; fg: string; accent: string };
  onChange?: (cells: string[][]) => void;
  onSelect?: () => void;
}) {
  const cells = element.cells;
  if (!cells?.length) return null;
  return (
    <table aria-label="Slide table" className="size-full table-fixed border-collapse"
      style={{ backgroundColor: colors.bg, color: colors.fg, fontSize: `${slideTableFontSize(element)}cqw`, lineHeight: 1.15 }}>
      <tbody>
        {cells.map((row, rowIndex) => <tr key={rowIndex} style={{ height: `${100 / cells.length}%` }}>
          {row.map((value, columnIndex) => {
            const header = rowIndex === 0 && element.header !== false;
            const Cell = header ? "th" : "td";
            return (
              <Cell key={columnIndex} scope={header ? "col" : undefined} className="relative border p-0 text-left align-top font-normal"
                style={{ borderColor: colors.accent, backgroundColor: header ? colors.accent : undefined, color: header ? colors.bg : undefined, fontWeight: header ? 650 : 400 }}>
                {onChange ? (
                  <textarea aria-label={`Row ${rowIndex + 1}, column ${columnIndex + 1}`} value={value} spellCheck={false}
                    onFocus={onSelect} onChange={(event) => {
                      const updated = cells.map((line, index) => index === rowIndex ? line.map((cell, column) => column === columnIndex ? event.target.value : cell) : line);
                      onChange(updated);
                    }}
                    className="absolute inset-0 size-full resize-none overflow-auto rounded-none border-0 bg-transparent p-[0.5cqw] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary" />
                ) : <span className="absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-[0.5cqw]">{value}</span>}
              </Cell>
            );
          })}
        </tr>)}
      </tbody>
    </table>
  );
}
