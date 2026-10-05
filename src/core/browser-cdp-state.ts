/**
 * Shared CDP-attach state for the orchestrator browser.
 *
 * Decouples the server route that launches the user's real Chrome
 * (src/server/routes/browser-dashboard.ts) from the orchestrator browser
 * executor that needs to know whether to drive it (src/llm/
 * orchestrator-browser-tools.ts). Both import this neutral module instead
 * of the llm layer reaching into the server layer.
 *
 * Holds the CDP debug port the "orchestrator" session is attached to, or
 * null when the user's Chrome isn't running (then tools fall back to
 * agent-browser's managed profile).
 */

let cdpPort: number | null = null;

export function setCdpTarget(port: number | null): void {
  cdpPort = port;
}

export function getCdpTarget(): number | null {
  return cdpPort;
}
