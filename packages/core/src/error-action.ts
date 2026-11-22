/**
 * Errors that say how to fix themselves. Some servers answer a failed request with a link to the
 * setting to change, e.g. Slack's MCP server: "App is not enabled for Slack MCP server access.
 * Please enable it here: https://api.slack.com/apps/A0…/app-assistant". The dashboard shows that
 * link as a "Fix it" button next to the error.
 */

/** Words of an instruction to the person: the link in the message is where to act. */
const INSTRUCTION = /\b(enable|turn on|activate|allow|approve|grant|install|configure|set up|visit|go to)\b/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>`)\]}]+/gi;

/**
 * The URL an error message tells the person to open to fix it, or undefined when the message
 * has no https link or does not ask them to do anything there.
 */
export function errorActionUrl(message: string | null | undefined): string | undefined {
  if (!message || !INSTRUCTION.test(message)) return undefined;
  for (const match of message.matchAll(URL_IN_TEXT)) {
    const raw = match[0].replace(/[.,;:!?\\]+$/, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    return url.toString();
  }
  return undefined;
}
