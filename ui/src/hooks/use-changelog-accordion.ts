/**
 * Which days and entries of the changelog timeline are open, remembered per viewer.
 *
 * Defaults: the most recent day open (its entries collapsed), older days collapsed, every entry
 * collapsed. Only what the person toggled is stored, so a new day that arrives with a deploy opens
 * by default and the previous one folds away unless they chose otherwise. A deep link
 * (`focusId`, the page's `#<entry-id>`) opens that entry's day and the entry.
 */
import { useCallback, useMemo, useState } from "react";

export const CHANGELOG_ACCORDION_STORAGE_KEY = "polpo-whats-new-accordion";

interface AccordionState {
  /** Days the person opened (true) or closed (false); the others follow the default. */
  days: Record<string, boolean>;
  /** Entries the person expanded. */
  entries: string[];
}

const EMPTY: AccordionState = { days: {}, entries: [] };

function readState(): AccordionState {
  try {
    const raw = localStorage.getItem(CHANGELOG_ACCORDION_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<AccordionState> | null;
    const days: Record<string, boolean> = {};
    if (parsed && typeof parsed.days === "object" && parsed.days) {
      for (const [date, open] of Object.entries(parsed.days)) if (typeof open === "boolean") days[date] = open;
    }
    const entries = Array.isArray(parsed?.entries) ? parsed.entries.filter((id): id is string => typeof id === "string") : [];
    return { days, entries };
  } catch {
    return EMPTY;
  }
}

function writeState(state: AccordionState) {
  try {
    localStorage.setItem(CHANGELOG_ACCORDION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage blocked: the state still holds for this visit
  }
}

function withFocus(state: AccordionState, focusDay: string | undefined, focusId: string | undefined): AccordionState {
  if (!focusDay || !focusId) return state;
  return {
    days: { ...state.days, [focusDay]: true },
    entries: state.entries.includes(focusId) ? state.entries : [...state.entries, focusId],
  };
}

export interface ChangelogAccordion {
  isDayOpen: (date: string) => boolean;
  toggleDay: (date: string) => void;
  isEntryOpen: (id: string) => boolean;
  /** The entry's details were opened at least once (kept mounted so closing animates). */
  isEntryMounted: (id: string) => boolean;
  toggleEntry: (id: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  allExpanded: boolean;
  noneExpanded: boolean;
}

export function useChangelogAccordion(
  days: ReadonlyArray<{ date: string; entries: ReadonlyArray<{ id: string }> }>,
  focusId?: string,
): ChangelogAccordion {
  const dayOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const day of days) for (const entry of day.entries) map.set(entry.id, day.date);
    return map;
  }, [days]);
  const newestDay = days[0]?.date;

  const [state, setState] = useState<AccordionState>(() => withFocus(readState(), focusId && dayOf.get(focusId), focusId));
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set(state.entries));
  // a deep link that changes while the timeline is shown (another #entry): open it too
  const [appliedFocus, setAppliedFocus] = useState(focusId);
  if (focusId !== appliedFocus) {
    setAppliedFocus(focusId);
    const focusDay = focusId ? dayOf.get(focusId) : undefined;
    if (focusId && focusDay) {
      setState((current) => withFocus(current, focusDay, focusId));
      setMounted((current) => new Set([...current, focusId]));
    }
  }

  const update = useCallback((next: (current: AccordionState) => AccordionState) => {
    setState((current) => {
      const value = next(current);
      writeState(value);
      return value;
    });
  }, []);

  const isDayOpen = useCallback(
    (date: string) => state.days[date] ?? date === newestDay,
    [state.days, newestDay],
  );
  const openEntries = useMemo(() => new Set(state.entries), [state.entries]);

  const toggleDay = useCallback((date: string) => {
    update((current) => ({ ...current, days: { ...current.days, [date]: !(current.days[date] ?? date === newestDay) } }));
  }, [update, newestDay]);

  const toggleEntry = useCallback((id: string) => {
    update((current) => ({
      ...current,
      entries: current.entries.includes(id) ? current.entries.filter((e) => e !== id) : [...current.entries, id],
    }));
    setMounted((current) => (current.has(id) ? current : new Set([...current, id])));
  }, [update]);

  const allIds = useMemo(() => [...dayOf.keys()], [dayOf]);

  const expandAll = useCallback(() => {
    update(() => ({ days: Object.fromEntries(days.map((day) => [day.date, true])), entries: allIds }));
    setMounted(new Set(allIds));
  }, [update, days, allIds]);

  const collapseAll = useCallback(() => {
    update(() => ({ days: Object.fromEntries(days.map((day) => [day.date, false])), entries: [] }));
  }, [update, days]);

  const allExpanded = allIds.length > 0 && allIds.every((id) => openEntries.has(id)) && days.every((day) => isDayOpen(day.date));
  const noneExpanded = !allIds.some((id) => openEntries.has(id)) && !days.some((day) => isDayOpen(day.date));

  return {
    isDayOpen,
    toggleDay,
    isEntryOpen: (id) => openEntries.has(id),
    isEntryMounted: (id) => mounted.has(id) || openEntries.has(id),
    toggleEntry,
    expandAll,
    collapseAll,
    allExpanded,
    noneExpanded,
  };
}
