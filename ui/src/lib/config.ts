/**
 * Static config from env vars.
 */
export const config = {
  baseUrl: import.meta.env.VITE_POLPO_API_URL ?? "http://localhost:3890",
  apiKey: import.meta.env.VITE_POLPO_API_KEY ?? undefined,
} as const;
