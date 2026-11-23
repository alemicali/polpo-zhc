import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Frame, Layers, Type } from "lucide-react";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { Artboard } from "./design-workspace";

type Element = DefaultTreeAdapterTypes.Element;
type Selection = { id: string; index: number };

function nameFor(node: Element) {
  const text = node.childNodes
    .filter((child) => child.nodeName === "#text")
    .map((child) => ("value" in child ? child.value.trim() : ""))
    .join(" ")
    .trim();
  return (
    node.attrs.find((a) => a.name === "aria-label" || a.name === "alt")?.value ||
    text.slice(0, 64) ||
    node.attrs.find((a) => a.name === "id")?.value ||
    node.tagName
  );
}

export function DesignLayers({
  boards,
  active,
  elements,
  selection,
  onSelect,
}: {
  boards: Artboard[];
  active: Artboard;
  elements: Element[];
  selection: Selection;
  onSelect: (selection: Selection) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const indices = new Map(elements.map((el, index) => [el, index]));
  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function rows(node: Element, depth: number): React.ReactNode {
    const index = indices.get(node)!;
    const children = node.childNodes.filter((c): c is Element => "tagName" in c && indices.has(c));
    const nested = children.length > 0;
    const key = active.id + ":" + index,
      open = !collapsed.has(key);
    const label = nameFor(node);
    const Icon = nested ? Layers : Type;
    return (
      <div
        key={key}
        role="treeitem"
        aria-level={depth + 2}
        aria-expanded={nested ? open : undefined}
        aria-selected={selection.id === active.id && selection.index === index}
      >
        <div
          className={
            "flex h-7 min-w-0 items-center rounded " +
            (selection.id === active.id && selection.index === index ? "bg-accent" : "")
          }
          style={{ paddingLeft: Math.min(88, depth * 12 + 12) }}
        >
          {nested ? (
            <button
              className="flex size-5 shrink-0 items-center justify-center"
              aria-label={(open ? "Collapse " : "Expand ") + label}
              onClick={() => toggle(key)}
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : (
            <span className="w-5" />
          )}
          <button
            className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
            title={label}
            onClick={() => onSelect({ id: active.id, index })}
          >
            <Icon className="size-3 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        </div>
        {open && nested && <div role="group">{children.map((c) => rows(c, depth + 1))}</div>}
      </div>
    );
  }
  return (
    <div role="tree" aria-label="Layers" className="mb-3 max-h-56 overflow-auto border-b pb-2 text-xs">
      {boards.map((b) => {
        const expanded = b.id === active.id && !collapsed.has(b.id);
        return (
          <div role="treeitem" key={b.id} aria-expanded={expanded} aria-level={1}>
            <div className="flex h-7 items-center gap-1">
              <button
                className="grid size-5 place-items-center"
                aria-label={(expanded ? "Collapse " : "Expand ") + b.name}
                onClick={() => {
                  if (b.id !== active.id) {
                    onSelect({ id: b.id, index: -1 });
                    setCollapsed((prev) => {
                      const n = new Set(prev);
                      n.delete(b.id);
                      return n;
                    });
                  } else toggle(b.id);
                }}
              >
                {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              </button>
              <button
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left font-medium"
                onClick={() => onSelect({ id: b.id, index: -1 })}
              >
                <Frame className="size-3" />
                <span className="truncate">{b.name}</span>
              </button>
            </div>
            {expanded && (
              <div role="group">
                {elements
                  .filter((el) => !el.parentNode || !indices.has(el.parentNode as Element))
                  .map((el) => rows(el, 0))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function tweaksFor(html: string) {
  const pending: DefaultTreeAdapterTypes.Node[] = [parse(html, { sourceCodeLocationInfo: true })];
  const variables = new Map<string, string>();
  let override: Element | undefined, headEnd: number | undefined;
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node && node.tagName === "head") headEnd = node.sourceCodeLocation?.endTag?.startOffset;
    if ("tagName" in node && node.tagName === "style") {
      if (node.attrs.some((a) => a.name === "data-polpo-design-tweaks")) override = node;
      const css = new CSSStyleSheet();
      css.replaceSync(node.childNodes.map((c) => ("value" in c ? c.value : "")).join(""));
      for (const rule of css.cssRules) {
        if (!(rule instanceof CSSStyleRule) || !rule.selectorText.split(",").some((s) => s.trim() === ":root"))
          continue;
        for (const name of Array.from(rule.style)) {
          if (name.startsWith("--")) variables.set(name, rule.style.getPropertyValue(name).trim());
        }
      }
    }
    if ("childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]);
  }
  return { variables, override, headEnd };
}

export function DesignTweaks({ board, onChange }: { board: Artboard; onChange: (html: string) => void }) {
  const { variables, override, headEnd } = useMemo(() => tweaksFor(board.html), [board.html]);
  function setValue(name: string, value: string) {
    if (!value.trim() || /[;<>{}]/.test(value) || value === variables.get(name)) return;
    const style = document.createElement("span").style;
    if (override) {
      const old = new CSSStyleSheet();
      old.replaceSync(override.childNodes.map((c) => ("value" in c ? c.value : "")).join(""));
      const rule = old.cssRules[0];
      if (rule instanceof CSSStyleRule) style.cssText = rule.style.cssText;
    }
    style.setProperty(name, value);
    const markup = "<style data-polpo-design-tweaks>:root{" + style.cssText + "}</style>";
    const loc = override?.sourceCodeLocation;
    const start = loc?.startOffset ?? headEnd ?? board.html.length;
    onChange(board.html.slice(0, start) + markup + board.html.slice(loc?.endOffset ?? start));
  }
  return (
    <div className="grid gap-3 text-xs">
      {!variables.size && <p className="text-muted-foreground">This artboard has no named design variables.</p>}
      {Array.from(variables).map(([name, value]) => {
        const label = name.slice(2);
        const hex = /^#[\da-f]{6}$/i.test(value)
          ? value
          : /^#[\da-f]{3}$/i.test(value)
            ? "#" +
              value
                .slice(1)
                .split("")
                .map((x) => x + x)
                .join("")
            : null;
        return (
          <label className="flex items-center gap-2" key={name}>
            <span className="min-w-0 flex-1 truncate" title={name}>
              {label}
            </span>
            {hex && (
              <input
                type="color"
                aria-label={label + " color"}
                className="h-7 w-8 cursor-pointer rounded border"
                value={hex}
                onChange={(e) => setValue(name, e.currentTarget.value)}
              />
            )}
            <input
              aria-label={label + " value"}
              key={value}
              className="w-24 rounded border bg-transparent px-2 py-1"
              defaultValue={value}
              onBlur={(e) => setValue(name, e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
          </label>
        );
      })}
    </div>
  );
}
