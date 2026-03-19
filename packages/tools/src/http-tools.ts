/**
 * HTTP/Fetch tools for agent network access.
 *
 * Provides structured HTTP capabilities so agents can:
 * - Fetch web pages and API endpoints
 * - Make REST API calls (GET, POST, PUT, DELETE, PATCH)
 * - Download files from URLs
 *
 * Uses Node.js native fetch (available since Node 18).
 * Enforces output size limits and timeout controls.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { resolveAllowedPaths, assertPathAllowed } from "./path-sandbox.js";
import { assertUrlAllowed } from "./ssrf-guard.js";

const MAX_RESPONSE_BYTES = 100_000;
const DEFAULT_TIMEOUT = 30_000;

// ─── Tool: http_fetch ───

const HttpFetchSchema = Type.Object({
  url: Type.String({ description: "URL to fetch (must be http:// or https://)" }),
  method: Type.Optional(Type.Union([
    Type.Literal("GET"),
    Type.Literal("POST"),
    Type.Literal("PUT"),
    Type.Literal("DELETE"),
    Type.Literal("PATCH"),
    Type.Literal("HEAD"),
    Type.Literal("OPTIONS"),
  ], { description: "HTTP method (default: GET)" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers as key-value pairs" })),
  body: Type.Optional(Type.String({ description: "Request body (for POST/PUT/PATCH). Use JSON string for JSON APIs." })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 30000)" })),
});

function createHttpFetchTool(): AgentTool<typeof HttpFetchSchema> {
  return {
    name: "http_fetch",
    label: "HTTP Fetch",
    description: "Make an HTTP request to a URL. Supports all HTTP methods, custom headers, and request bodies. " +
      "Returns status code, response headers, and body. Use for API calls, fetching web pages, or checking endpoints.",
    parameters: HttpFetchSchema,
    async execute(_id, params, signal) {
      const url = params.url;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return {
          content: [{ type: "text", text: "Error: URL must start with http:// or https://" }],
          details: { error: "invalid_url" },
        };
      }

      try {
        assertUrlAllowed(url);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          details: { error: "ssrf_blocked" },
        };
      }

      const method = params.method ?? "GET";
      const timeout = params.timeout ?? DEFAULT_TIMEOUT;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);

        // Combine external signal with timeout
        if (signal) {
          signal.addEventListener("abort", () => controller.abort(), { once: true });
        }

        const response = await fetch(url, {
          method,
          headers: params.headers,
          body: params.body,
          signal: controller.signal,
          redirect: "follow",
        });

        clearTimeout(timer);

        const contentType = response.headers.get("content-type") ?? "";
        const isText = contentType.includes("text") || contentType.includes("json") ||
          contentType.includes("xml") || contentType.includes("javascript") ||
          contentType.includes("html") || contentType.includes("css") ||
          contentType.includes("svg");

        let body: string;
        if (isText) {
          const text = await response.text();
          body = text.length > MAX_RESPONSE_BYTES
            ? text.slice(0, MAX_RESPONSE_BYTES) + `\n[truncated — ${text.length} total bytes]`
            : text;
        } else {
          const buffer = await response.arrayBuffer();
          body = `[Binary response: ${buffer.byteLength} bytes, content-type: ${contentType}]`;
        }

        // Extract relevant response headers
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of response.headers.entries()) {
          if (["content-type", "content-length", "location", "set-cookie",
               "cache-control", "x-ratelimit-remaining", "retry-after"].includes(key.toLowerCase())) {
            responseHeaders[key] = value;
          }
        }

        const resultText = [
          `Status: ${response.status} ${response.statusText}`,
          `Headers: ${JSON.stringify(responseHeaders)}`,
          ``,
          body,
        ].join("\n");

        return {
          content: [{ type: "text", text: resultText }],
          details: {
            url,
            method,
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            bodyLength: body.length,
          },
        };
      } catch (err: any) {
        const message = err.name === "AbortError" ? "Request timed out" : err.message;
        return {
          content: [{ type: "text", text: `HTTP error: ${message}` }],
          details: { url, method, error: message },
        };
      }
    },
  };
}

// ─── Tool: http_download ───

const HttpDownloadSchema = Type.Object({
  url: Type.String({ description: "URL to download from" }),
  path: Type.String({ description: "Local file path to save the downloaded content" }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional request headers" })),
});

function createHttpDownloadTool(cwd: string, sandbox: string[]): AgentTool<typeof HttpDownloadSchema> {
  return {
    name: "http_download",
    label: "HTTP Download",
    description: "Download a file from a URL and save it locally. Use for downloading assets, binaries, or data files.",
    parameters: HttpDownloadSchema,
    async execute(_id, params, signal) {
      const url = params.url;
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        return {
          content: [{ type: "text", text: "Error: URL must start with http:// or https://" }],
          details: { error: "invalid_url" },
        };
      }

      try {
        assertUrlAllowed(url);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          details: { error: "ssrf_blocked" },
        };
      }

      const filePath = resolve(cwd, params.path);
      assertPathAllowed(filePath, sandbox, "http_download");

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120_000); // 2 min for downloads

        if (signal) {
          signal.addEventListener("abort", () => controller.abort(), { once: true });
        }

        const response = await fetch(url, {
          headers: params.headers,
          signal: controller.signal,
          redirect: "follow",
        });

        clearTimeout(timer);

        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Download failed: ${response.status} ${response.statusText}` }],
            details: { url, status: response.status, error: "http_error" },
          };
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, buffer);

        return {
          content: [{ type: "text", text: `Downloaded ${buffer.byteLength} bytes to ${filePath}` }],
          details: { url, path: filePath, bytes: buffer.byteLength },
        };
      } catch (err: any) {
        const message = err.name === "AbortError" ? "Download timed out" : err.message;
        return {
          content: [{ type: "text", text: `Download error: ${message}` }],
          details: { url, error: message },
        };
      }
    },
  };
}

// ─── Factory ───

export type HttpToolName = "http_fetch" | "http_download";

export const ALL_HTTP_TOOL_NAMES: HttpToolName[] = ["http_fetch", "http_download"];

/**
 * Create HTTP tools for network access.
 *
 * @param cwd - Working directory for resolving download paths
 * @param allowedPaths - Sandbox paths for download destination validation
 * @param allowedTools - Optional filter
 */
export function createHttpTools(
  cwd: string,
  allowedPaths?: string[],
  allowedTools?: string[],
): AgentTool<any>[] {
  const sandbox = resolveAllowedPaths(cwd, allowedPaths);

  const factories: Record<HttpToolName, () => AgentTool<any>> = {
    http_fetch: () => createHttpFetchTool(),
    http_download: () => createHttpDownloadTool(cwd, sandbox),
  };

  const names = allowedTools
    ? ALL_HTTP_TOOL_NAMES.filter(n => allowedTools.some(a => a.toLowerCase() === n))
    : ALL_HTTP_TOOL_NAMES;

  return names.map(n => factories[n]());
}
