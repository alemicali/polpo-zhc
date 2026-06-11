import { Group, Panel, Separator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof Group>) {
  return <Group className={cn("h-full w-full", className)} {...props} />;
}

function ResizablePanel(props: React.ComponentProps<typeof Panel>) {
  return <Panel {...props} />;
}

/**
 * Resize handle — invisible at rest, comes alive on hover and bursts when
 * dragging. Three layered marks:
 *
 *   1. Generous hit area (8px) so the user catches it easily, but stays
 *      visually quiet (transparent).
 *   2. A 1px hairline tinted with --border at rest, that thickens to 3px
 *      and switches to --primary on hover/drag, picking up the active
 *      palette automatically.
 *   3. A floating "grip pill" — vertical pill in --primary that scales in
 *      from 0 on hover, with a soft glow halo that bleeds into the
 *      adjacent panels. Three tiny dots fade in *only* during drag, so the
 *      affordance escalates: idle → hint → grab → drag.
 *
 * Uses --primary / --border tokens so it follows whichever palette is
 * active (Tide Pool teal, Cyber neon, Brutalist black, etc.).
 */
function ResizableHandle({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        "relative group/handle isolate",
        // 8px hit area, but the visible hairline sits at exactly the centre.
        // Negative margin keeps the layout from shifting.
        "w-2 -mx-[3px]",
        // Cursor + outline reset
        "outline-none cursor-col-resize",
        // Faint colour wash on the whole hit area when interacting — extra
        // depth cue without being intrusive.
        "before:absolute before:inset-0 before:transition-colors before:duration-200",
        "hover:before:bg-primary/[0.05]",
        "data-[separator=active]:before:bg-primary/[0.08]",
        className,
      )}
      {...props}
    >
      {/* ── Hairline ── always there, palette-tinted ── */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2",
          "w-px rounded-full bg-border/70",
          "transition-[width,background-color,box-shadow] duration-300 ease-out",
          // Hover: thicker, primary, glow halo that fades into the panels
          "group-hover/handle:w-[3px] group-hover/handle:bg-primary",
          "group-hover/handle:shadow-[0_0_10px_color-mix(in_oklch,var(--primary)_55%,transparent),0_0_28px_color-mix(in_oklch,var(--primary)_22%,transparent)]",
          // Active (dragging) — same shape as hover, deeper glow
          "[[data-separator=active]_&]:w-[3px] [[data-separator=active]_&]:bg-primary",
          "[[data-separator=active]_&]:shadow-[0_0_14px_color-mix(in_oklch,var(--primary)_70%,transparent),0_0_36px_color-mix(in_oklch,var(--primary)_30%,transparent)]",
        )}
      />

      {/* ── Grip pill ── floats in on hover, primary-coloured ── */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
          "h-9 w-[5px] rounded-full bg-primary",
          "shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_40%,transparent),0_4px_18px_color-mix(in_oklch,var(--primary)_55%,transparent)]",
          // Animation: scale in from a hair-line, fade to full opacity
          "scale-y-0 scale-x-0 opacity-0",
          "transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          "group-hover/handle:scale-y-100 group-hover/handle:scale-x-100 group-hover/handle:opacity-100",
          "[[data-separator=active]_&]:scale-y-100 [[data-separator=active]_&]:scale-x-100 [[data-separator=active]_&]:opacity-100",
          // While dragging the pill grows a touch — committed feedback
          "[[data-separator=active]_&]:h-11",
        )}
      />

      {/* ── Grip dots ── fade in only during drag (active state) ── */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
          "flex flex-col gap-[3px]",
          "opacity-0 transition-opacity duration-150",
          "[[data-separator=active]_&]:opacity-100",
        )}
      >
        <span className="block h-[3px] w-[3px] rounded-full bg-primary-foreground/85" />
        <span className="block h-[3px] w-[3px] rounded-full bg-primary-foreground/85" />
        <span className="block h-[3px] w-[3px] rounded-full bg-primary-foreground/85" />
      </span>
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
