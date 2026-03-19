/** Typed HTTP error for API responses. */
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
