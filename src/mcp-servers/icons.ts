/**
 * The ready-made hosted servers' official marks, bundled with the dashboard under
 * ui/public/hosted-server-icons (sources in ui/src/lib/hosted-server-icons.ts, which has the same map).
 * A template's `icon` names one; the connector a server becomes gets it as its iconUrl (and MCP's icon_url).
 */
export const HOSTED_SERVER_ICON_FILES: Record<string, { light: string; dark?: string }> = {
  gelato: { light: "gelato.svg" },
  printful: { light: "printful.svg" },
  printify: { light: "printify.svg", dark: "printify-dark.svg" },
};

/** The dashboard paths of a bundled hosted-server icon (`icon` key), if there is one. */
export function hostedServerIconUrls(key: string | null | undefined): { iconUrl?: string; iconDarkUrl?: string } {
  const entry = key && Object.hasOwn(HOSTED_SERVER_ICON_FILES, key) ? HOSTED_SERVER_ICON_FILES[key] : undefined;
  if (!entry) return {};
  return { iconUrl: `/hosted-server-icons/${entry.light}`, ...(entry.dark ? { iconDarkUrl: `/hosted-server-icons/${entry.dark}` } : {}) };
}
