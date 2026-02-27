/**
 * Static config from env vars.
 */
export const config = {
  baseUrl: import.meta.env.VITE_POLPO_API_URL ?? "",
  apiKey: import.meta.env.VITE_POLPO_API_KEY ?? undefined,
} as const;
