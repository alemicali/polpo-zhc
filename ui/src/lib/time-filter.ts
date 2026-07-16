export type TimeField = "createdAt" | "updatedAt";
export type TimeRange = "today" | "7d" | "30d";

export interface TimeFilterState {
  field: TimeField;
  range: TimeRange;
  after: number;
}

export const timeRangePresets: { value: TimeRange; label: string; days: number }[] = [
  { value: "today", label: "Today", days: 1 },
  { value: "7d", label: "Last 7 days", days: 7 },
  { value: "30d", label: "Last 30 days", days: 30 },
];

export function getTimeRangeAfter(range: TimeRange, now = new Date()): number {
  const preset = timeRangePresets.find((item) => item.value === range);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((preset?.days ?? 1) - 1));
  return start.getTime();
}

export function createDefaultTimeFilter(field: TimeField = "updatedAt"): TimeFilterState {
  return { field, range: "today", after: getTimeRangeAfter("today") };
}

export function getTimeRangeLabel(range: TimeRange): string {
  return timeRangePresets.find((preset) => preset.value === range)?.label ?? range;
}
