/**
 * SSRF guard — blocks HTTP requests to internal/private network addresses.
 *
 * Prevents agents from making requests to:
 * - localhost (127.0.0.0/8, ::1, 0.0.0.0, localhost)
 * - RFC1918 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local / cloud metadata (169.254.0.0/16, metadata.google.internal)
 */

/** Hostnames that are always blocked. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
]);

/**
 * Parse an IPv4 address string into a 32-bit number.
 * Returns undefined if not a valid IPv4 address.
 */
function parseIPv4(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;

  let num = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    num = (num << 8) | octet;
  }
  return num >>> 0; // unsigned 32-bit
}

/**
 * Check whether an IPv4 address (as 32-bit number) falls within a CIDR range.
 */
function inRange(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/**
 * Assert that a URL does not point to a private/internal network address.
 * Throws an Error if the URL is blocked.
 *
 * @param urlString - The URL to check
 * @throws Error with descriptive message if the URL targets an internal address
 */
export function assertUrlAllowed(urlString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid URL: ${urlString}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Strip IPv6 brackets
  const bareHost = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // Block known hostnames
  if (BLOCKED_HOSTNAMES.has(bareHost)) {
    throw new Error(`SSRF blocked: requests to ${bareHost} are not allowed`);
  }

  // Block IPv6 loopback
  if (bareHost === "::1" || bareHost === "::0" || bareHost === "0:0:0:0:0:0:0:1" || bareHost === "0:0:0:0:0:0:0:0") {
    throw new Error(`SSRF blocked: requests to ${bareHost} are not allowed`);
  }

  // Block 0.0.0.0
  if (bareHost === "0.0.0.0") {
    throw new Error(`SSRF blocked: requests to 0.0.0.0 are not allowed`);
  }

  // Check IPv4 ranges
  const ipv4 = parseIPv4(bareHost);
  if (ipv4 !== undefined) {
    // 127.0.0.0/8 — loopback
    if (inRange(ipv4, 0x7f000000, 8)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (loopback) are not allowed`);
    }
    // 10.0.0.0/8 — RFC1918
    if (inRange(ipv4, 0x0a000000, 8)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (private network) are not allowed`);
    }
    // 172.16.0.0/12 — RFC1918
    if (inRange(ipv4, 0xac100000, 12)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (private network) are not allowed`);
    }
    // 192.168.0.0/16 — RFC1918
    if (inRange(ipv4, 0xc0a80000, 16)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (private network) are not allowed`);
    }
    // 169.254.0.0/16 — link-local / cloud metadata
    if (inRange(ipv4, 0xa9fe0000, 16)) {
      throw new Error(`SSRF blocked: requests to ${bareHost} (link-local/metadata) are not allowed`);
    }
  }
}
