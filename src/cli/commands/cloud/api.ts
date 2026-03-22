/**
 * HTTP client for the polpo-cloud API.
 *
 * Wraps fetch with Authorization header and JSON handling.
 */
import type { Credentials } from "./config.js";

export interface ApiResponse<T = unknown> {
  status: number;
  data: T;
}

export interface ApiClient {
  get<T = unknown>(path: string): Promise<ApiResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<ApiResponse<T>>;
  delete<T = unknown>(path: string): Promise<ApiResponse<T>>;
}

export function createApiClient(credentials: Credentials): ApiClient {
  const { apiKey, baseUrl } = credentials;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let data: T;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      data = (await res.json()) as T;
    } else {
      data = (await res.text()) as unknown as T;
    }

    return { status: res.status, data };
  }

  return {
    get: <T = unknown>(path: string) => request<T>("GET", path),
    post: <T = unknown>(path: string, body?: unknown) =>
      request<T>("POST", path, body),
    put: <T = unknown>(path: string, body?: unknown) =>
      request<T>("PUT", path, body),
    delete: <T = unknown>(path: string) => request<T>("DELETE", path),
  };
}
