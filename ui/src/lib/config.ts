/**
 * Static config from env vars. Used as initial values.
 * If projectId is "auto" or empty, the app will discover it from GET /projects.
 */
export const config = {
  baseUrl: import.meta.env.VITE_POLPO_API_URL ?? "http://localhost:3890",
  projectId: import.meta.env.VITE_POLPO_PROJECT_ID ?? "auto",
  apiKey: import.meta.env.VITE_POLPO_API_KEY ?? undefined,
} as const;

/**
 * Discover the first available project from the server.
 * Falls back to the configured projectId if discovery fails.
 */
export async function resolveProjectId(): Promise<string> {
  const configured = config.projectId;
  if (configured && configured !== "auto") return configured;

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;
    const res = await fetch(`${config.baseUrl}/api/v1/projects`, { headers });
    if (!res.ok) return "tmp";
    const json = await res.json() as { ok: boolean; data: Array<{ id: string }> };
    if (json.ok && json.data.length > 0) return json.data[0].id;
  } catch {
    // Discovery failed — fall back
  }
  return "tmp";
}
