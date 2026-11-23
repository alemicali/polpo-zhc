/**
 * The instance's look for the MCP cards (widgets in a third-party host): the brand, status and
 * agent colours its custom look sets, per mode (widgetAppearance). The card uses them over the
 * host's colours and its own light/dark defaults, so it matches the dashboard. One local GET.
 */
import { widgetAppearance } from "@polpo-ai/core/appearance";
import type { AppearanceSettings } from "@polpo-ai/core";
import { unwrap, type McpDeps } from "./kit.js";

export type CardAppearance = ReturnType<typeof widgetAppearance>;

export async function cardAppearance(deps: McpDeps): Promise<CardAppearance> {
  try {
    const r = unwrap(await deps.api("GET", "/api/v1/config/appearance"));
    return r.ok && r.data && typeof r.data === "object" ? widgetAppearance(r.data as AppearanceSettings) : undefined;
  } catch {
    return undefined;
  }
}
