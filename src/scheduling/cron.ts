// Minimal cron expression parser — zero external dependencies.
//
// Supports standard 5-field cron: minute hour day-of-month month day-of-week
//   - Numbers, ranges (1-5), steps (star/10), lists (1,3,5), wildcards (star)
//   - Day-of-week: 0-7 (0 and 7 = Sunday)
//
// Does NOT support: @yearly/@monthly shortcuts, seconds field, L/W/# modifiers.

interface CronField {
  values: Set<number>;
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59],   // minute
  [0, 23],   // hour
  [1, 31],   // day of month
  [1, 12],   // month
  [0, 7],    // day of week (0 and 7 = Sunday)
];

/** Parse a single cron field (e.g. "1,3,5", "1-5"). */
function parseField(field: string, min: number, max: number): CronField {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const range = stepMatch ? stepMatch[1] : part;

    if (range === "*") {
      for (let i = min; i <= max; i += step) values.add(i);
    } else if (range.includes("-")) {
      const [startStr, endStr] = range.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid cron range: ${range}`);
      for (let i = start; i <= end; i += step) {
        if (i >= min && i <= max) values.add(i);
      }
    } else {
      const val = parseInt(range, 10);
      if (isNaN(val)) throw new Error(`Invalid cron value: ${range}`);
      if (val >= min && val <= max) values.add(val);
    }
  }

  return { values };
}

/**
 * Parse a 5-field cron expression into a structured object.
 */
export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${expression}": expected 5 fields, got ${fields.length}`);
  }

  const parsed: ParsedCron = {
    minute: parseField(fields[0], ...FIELD_RANGES[0]),
    hour: parseField(fields[1], ...FIELD_RANGES[1]),
    dayOfMonth: parseField(fields[2], ...FIELD_RANGES[2]),
    month: parseField(fields[3], ...FIELD_RANGES[3]),
    dayOfWeek: parseField(fields[4], ...FIELD_RANGES[4]),
  };

  // Normalize day-of-week: 7 → 0 (both mean Sunday)
  if (parsed.dayOfWeek.values.has(7)) {
    parsed.dayOfWeek.values.add(0);
    parsed.dayOfWeek.values.delete(7);
  }

  return parsed;
}

/**
 * Check if a given Date matches a parsed cron expression.
 */
export function matchesCron(cron: ParsedCron, date: Date): boolean {
  return (
    cron.minute.values.has(date.getMinutes()) &&
    cron.hour.values.has(date.getHours()) &&
    cron.dayOfMonth.values.has(date.getDate()) &&
    cron.month.values.has(date.getMonth() + 1) && // JS months are 0-based
    cron.dayOfWeek.values.has(date.getDay())
  );
}

/**
 * Calculate the next occurrence of a cron expression after the given date.
 * Searches up to ~2 years ahead to avoid infinite loops.
 */
export function nextCronOccurrence(expression: string, after: Date): Date | null {
  const cron = parseCron(expression);

  // Start from the next minute boundary
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to ~2 years ahead (prevent infinite loop)
  const maxIterations = 525_960; // ~365 * 24 * 60 minutes
  for (let i = 0; i < maxIterations; i++) {
    if (matchesCron(cron, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null; // No match found within search window
}

/**
 * Check if a string looks like a cron expression (5 space-separated fields).
 */
export function isCronExpression(str: string): boolean {
  return /^\s*(\S+\s+){4}\S+\s*$/.test(str);
}
