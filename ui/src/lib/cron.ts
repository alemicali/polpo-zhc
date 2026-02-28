const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Convert a cron expression to a human-readable string.
 * Handles common patterns; falls back to the raw expression.
 */
export function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, , dow] = parts;

  // Every N minutes: */N * * * *
  if (min.startsWith("*/") && hour === "*" && dom === "*" && dow === "*") {
    return `Every ${min.slice(2)} minutes`;
  }

  // Every N hours: 0 */N * * *
  if (min === "0" && hour.startsWith("*/") && dom === "*" && dow === "*") {
    return `Every ${hour.slice(2)} hours`;
  }

  const hh = parseInt(hour, 10);
  const mm = parseInt(min, 10);
  if (isNaN(hh) || isNaN(mm)) return expr;
  const time = `${hh}:${mm.toString().padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;

  // Daily: 0 H * * *
  if (dom === "*" && dow === "*") {
    return `Daily at ${time}`;
  }

  // Weekly: 0 H * * D
  if (dom === "*" && /^\d$/.test(dow)) {
    const day = DAYS[parseInt(dow, 10)] ?? dow;
    return `Every ${day} at ${time}`;
  }

  // Monthly: 0 H D * *
  if (/^\d+$/.test(dom) && dow === "*") {
    return `Monthly on day ${dom} at ${time}`;
  }

  return expr;
}
