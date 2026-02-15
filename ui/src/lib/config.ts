export const config = {
  baseUrl: import.meta.env.VITE_POLPO_API_URL ?? "http://localhost:3890",
  projectId: import.meta.env.VITE_POLPO_PROJECT_ID ?? "tmp",
  apiKey: import.meta.env.VITE_POLPO_API_KEY ?? undefined,
} as const;
