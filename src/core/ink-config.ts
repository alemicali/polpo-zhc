/**
 * Where Ink lives for this instance: the hub API (catalogue, install counts) and the registry
 * the agents are pointed to. Self-hosted hubs set them through the environment.
 *
 *   POLPO_INK_API_URL    the hub API (default https://polpo.sh/api)
 *   POLPO_INK_REGISTRY   the registry, "owner/repo" (default lumea-labs/ink-registry)
 */

export const inkApiUrl = (): string => (process.env.POLPO_INK_API_URL || "https://polpo.sh/api").replace(/\/+$/, "");

export const inkRegistry = (): string => process.env.POLPO_INK_REGISTRY || "lumea-labs/ink-registry";
