/** Pages still in beta: their entries and titles carry a "Beta" badge (components/shared/beta-badge.tsx). */

/** Pages in beta (their paths; detail pages share the badge only where they say so). */
const BETA_PATHS: ReadonlySet<string> = new Set(["/artifacts"]);

/** Is this page (a path, optionally with a query) in beta? */
export function isBetaPath(to: string): boolean {
  const q = to.indexOf("?");
  return BETA_PATHS.has(q === -1 ? to : to.slice(0, q));
}
