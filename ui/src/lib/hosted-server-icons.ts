/**
 * The ready-made hosted servers' official marks, bundled under ui/public/hosted-server-icons (never
 * fetched at runtime). A template's `icon` (and the spec / connector it creates) names one of these.
 * The server has the same map (src/mcp-servers/icons.ts), for the connector's iconUrl and MCP's icon_url;
 * ui/tests/connector-icons.test.tsx keeps the two in step with the files.
 *
 * Sources (each SVG also says where it came from):
 *   printful      https://static.cdn.printful.com/static/v882/images/layout/logo-icon.svg (www.printful.com header)
 *   printify      https://printify.com/pfh/assets/logo-small.svg (printify.com header); the dark variant is the
 *                 same mark in the white of https://printify.com/pfh/media/logo-white-BDD3KAV2.svg
 *   gelato        https://www.gelato.com/assets/favicon.svg (www.gelato.com apple-touch-icon; white mark on a black disc)
 */
export const HOSTED_SERVER_ICONS: Record<string, { light: string; dark?: string }> = {
  gelato: { light: "gelato.svg" },
  printful: { light: "printful.svg" },
  printify: { light: "printify.svg", dark: "printify-dark.svg" },
};

const path = (file: string) => `${import.meta.env.BASE_URL ?? "/"}hosted-server-icons/${file}`.replace(/\/{2,}/g, "/");

/** The bundled icon of a hosted server / template (its `icon` key); empty when it has none (letter tile). */
export function hostedServerIcon(key: string | undefined): { iconUrl?: string; iconDarkUrl?: string } {
  const entry = key && Object.hasOwn(HOSTED_SERVER_ICONS, key) ? HOSTED_SERVER_ICONS[key] : undefined;
  if (!entry) return {};
  return { iconUrl: path(entry.light), ...(entry.dark ? { iconDarkUrl: path(entry.dark) } : {}) };
}

/** A hosted server's bundled icon: its own `icon`, else its template's (servers made before the template had one). */
export function hostedServerIconFor(server: { icon?: string; template?: string }): { iconUrl?: string; iconDarkUrl?: string } {
  const own = hostedServerIcon(server.icon);
  return own.iconUrl ? own : hostedServerIcon(server.template);
}

/** A bundled hosted-server icon URL (the server's /hosted-server-icons/<file>, or one from above) under the base path. */
export function bundledHostedIconSrc(url: string | undefined): string | undefined {
  const m = url ? /(?:^|\/)hosted-server-icons\/([\w.-]+\.(?:svg|png))$/.exec(url) : null;
  return m ? path(m[1]!) : undefined;
}
