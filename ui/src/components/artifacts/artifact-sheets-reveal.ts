import type { Sheet } from "./artifact-sheets-model";

export type SheetAnimations = {
  cells: Map<HTMLElement, Animation>;
  outlines: Map<HTMLElement, Animation>;
  sweep?: Animation;
  badge?: Animation;
  lastSweep: number;
};

function trackAnimation(target: HTMLElement, animation: Animation, running: Map<HTMLElement, Animation>) {
  running.get(target)?.cancel();
  running.set(target, animation);
  animation.onfinish = animation.oncancel = () => {
    if (running.get(target) === animation) running.delete(target);
  };
}

export function stopSheetAnimations(animations: SheetAnimations) {
  animations.sweep?.cancel();
  animations.badge?.cancel();
  for (const animation of animations.cells.values()) animation.cancel();
  for (const animation of animations.outlines.values()) animation.cancel();
  animations.cells.clear();
  animations.outlines.clear();
  animations.sweep = undefined;
  animations.badge = undefined;
  animations.lastSweep = -Infinity;
}

export function settleWorksheet(animations: SheetAnimations, badge: HTMLDivElement | null) {
  const fading = [{ opacity: 0.85 }, { opacity: 0 }];
  const options: KeyframeAnimationOptions = { delay: 1600, duration: 400, fill: "backwards", easing: "ease-out" };
  for (const [element] of animations.outlines) {
    trackAnimation(element, element.animate(fading, options), animations.outlines);
  }
  if (badge && animations.badge) {
    animations.badge.cancel();
    animations.badge = badge.animate(fading, options);
  }
}

export function revealWorksheet(viewport: HTMLDivElement, sweep: HTMLDivElement, badge: HTMLDivElement | null,
  cells: Sheet["cells"], prior: Sheet["cells"] | undefined, animations: SheetAnimations, streaming: boolean) {
  if (cells === prior || !sweep.animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const changedLabels = Array.from(viewport.querySelectorAll<HTMLElement>("[data-sheet-value]")).filter((label) => {
    const key = label.dataset.sheetValue ?? "";
    return cells[key] && cells[key] !== prior?.[key];
  });
  if (!changedLabels.length) return;
  const bounds = viewport.getBoundingClientRect();
  const visibleTop = bounds.top + (viewport.querySelector("thead")?.getBoundingClientRect().height ?? 0);
  const visibleLeft = bounds.left + (viewport.querySelector("thead th")?.getBoundingClientRect().width ?? 0);
  const visibleBottom = bounds.top + viewport.clientHeight;
  const visibleRight = bounds.left + viewport.clientWidth;
  const changing = changedLabels.flatMap((label) => {
    const rect = label.getBoundingClientRect();
    if (rect.bottom <= visibleTop || rect.top >= visibleBottom || rect.right <= visibleLeft || rect.left >= visibleRight) return [];
    return [{ label, top: Math.max(visibleTop, rect.top), left: Math.max(visibleLeft, rect.left) }];
  });
  if (changing.length === 0) return;

  const first = Math.min(...changing.map((cell) => cell.top));
  const last = Math.max(...changing.map((cell) => cell.top));
  const rowTravel = Math.max(32, last - first);
  const across = Math.max(1, visibleRight - visibleLeft);
  const duration = Math.min(740, 430 + rowTravel / 2);
  const shift = (y: number) => `translateY(${y - bounds.top}px)`;
  const now = performance.now();
  if (now - animations.lastSweep >= 800) {
    animations.sweep = sweep.animate([
      { transform: shift(first - 12), opacity: 0, offset: 0 },
      { opacity: 1, offset: 0.12 },
      { opacity: 0.8, offset: 0.62 },
      { transform: shift(Math.min(visibleBottom, last + 12)), opacity: 0, offset: 1 },
    ], { duration, easing: "cubic-bezier(.17,.67,.31,1)" });
    animations.lastSweep = now;
  }

  // Keep the first paint bounded on dense sheets while the sweep covers the entire visible range.
  const step = Math.max(1, Math.ceil(changing.length / 160));
  for (let index = 0; index < changing.length; index += step) {
    const { label, top, left } = changing[index];
    const delay = (top - first) / rowTravel * (duration - 310) + (left - visibleLeft) / across * 65;
    trackAnimation(label, label.animate([
      { opacity: 0.62, transform: "translateY(3px)", backgroundColor: "transparent" },
      { opacity: 1, transform: "translateY(0)", backgroundColor: "color-mix(in oklab, var(--primary) 16%, transparent)", offset: 0.45 },
      { opacity: 1, transform: "translateY(0)", backgroundColor: "transparent" },
    ], { delay, duration: 200, fill: "backwards", easing: "cubic-bezier(.2,.75,.24,1)" }), animations.cells);
    if (streaming) {
      const outline = label.closest("td")?.querySelector<HTMLElement>("[data-sheet-outline]");
      if (!outline) continue;
      trackAnimation(outline, outline.animate([
        { opacity: 0.65 }, { opacity: 1, offset: 0.5 }, { opacity: 0.65 },
      ], { duration: 2000, iterations: Infinity, easing: "ease-in-out" }), animations.outlines);
    }
  }
  while (animations.outlines.size > 160) {
    const firstOutline = animations.outlines.keys().next().value;
    if (!firstOutline) break;
    animations.outlines.get(firstOutline)?.cancel();
    animations.outlines.delete(firstOutline);
  }
  if (streaming && badge) {
    const active = changing[0];
    badge.style.transform = `translate(${Math.max(0, active.left - bounds.left)}px, ${Math.max(0, active.top - bounds.top - 17)}px)`;
    animations.badge?.cancel();
    animations.badge = badge.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, fill: "forwards" });
  }
}
