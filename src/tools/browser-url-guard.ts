/**
 * Browser tools only open web pages. file:, view-source:, chrome:, devtools:, javascript:, data:,
 * ftp: and every other scheme would let a page read the server's own files or run code in a
 * privileged context, so they are refused before the URL reaches the browser.
 */

// eslint-disable-next-line no-control-regex
const IGNORED = /[\u0000-\u0020\u007f-\u009f\u200b-\u200d\u2028\u2029\ufeff]/g;

/** What a browser would see: leading spaces, control characters, tabs and newlines dropped, percent-escapes decoded. */
function normalize(raw: string): string {
  let text = raw.replace(IGNORED, "");
  for (let i = 0; i < 4 && /%[0-9a-f]{2}/i.test(text); i++) {
    try { text = decodeURIComponent(text); } catch { break; }
    text = text.replace(IGNORED, "");
  }
  return text;
}

/**
 * Throw unless `url` is a web address: http:, https:, about:blank, or a scheme-less host or path
 * (which the browser opens as https, "localhost:3000" included). Returns the URL without stray
 * whitespace and control characters.
 */
export function assertWebUrl(url: string, toolName = "browser"): string {
  const raw = String(url ?? "");
  const text = normalize(raw);
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  if (!match) return raw.replace(IGNORED, "");
  const scheme = match[1]!.toLowerCase();
  if (scheme === "http" || scheme === "https") return raw.replace(IGNORED, "");
  if (text.toLowerCase() === "about:blank") return "about:blank";
  // "example.com:8080/x" and "localhost:3000" are a host and a port; "javascript:1/alert(1)" is not
  if ((scheme === "localhost" || scheme.includes(".")) && /^[^:]+:\d+(?:[/?#]|$)/.test(text)) return raw.replace(IGNORED, "");
  throw new Error(`[browser] ${toolName}: only http and https pages can be opened (refused "${scheme}:" URL)`);
}
