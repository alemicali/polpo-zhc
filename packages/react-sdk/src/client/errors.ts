import type { ErrorCode } from "./types.js";

export class PolpoApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, code: ErrorCode, status: number, details?: unknown) {
    super(message);
    this.name = "PolpoApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  get isNotFound(): boolean {
    return this.code === "NOT_FOUND";
  }

  get isAuthError(): boolean {
    return this.code === "AUTH_REQUIRED" || this.code === "FORBIDDEN";
  }

  get isValidationError(): boolean {
    return this.code === "VALIDATION_ERROR";
  }

  get isConflict(): boolean {
    return this.code === "INVALID_STATE" || this.code === "CONFLICT";
  }
}
