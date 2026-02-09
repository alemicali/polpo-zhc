import type { MiddlewareHandler } from "hono";

/**
 * Known error class for API errors with specific HTTP status codes.
 */
export class ApiHttpError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number = 400,
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

/**
 * Global error handling middleware.
 * Catches thrown errors and maps to ApiError responses.
 */
export function errorMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err: unknown) {
      if (err instanceof ApiHttpError) {
        return c.json(
          { ok: false, error: err.message, code: err.code },
          err.status as 400,
        );
      }

      const message = err instanceof Error ? err.message : String(err);

      // Map known error patterns to status codes
      if (message.includes("not found") || message.includes("Not found")) {
        return c.json(
          { ok: false, error: message, code: "NOT_FOUND" },
          404,
        );
      }

      if (message.includes("Cannot") && (message.includes("state") || message.includes("status"))) {
        return c.json(
          { ok: false, error: message, code: "INVALID_STATE" },
          409,
        );
      }

      if (message.includes("already exists") || message.includes("already active")) {
        return c.json(
          { ok: false, error: message, code: "CONFLICT" },
          409,
        );
      }

      return c.json(
        { ok: false, error: message, code: "INTERNAL_ERROR" },
        500,
      );
    }
  };
}
