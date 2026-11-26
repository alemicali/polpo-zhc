/** The Channels section's calls to the instance's API, and secret helpers. */
import type { PolpoApi } from "@/components/config/telegram-connect";
import { apiFetch, apiUrl } from "@/lib/config";

/** The instance's API ({ ok, data, error }), with the session cookie and the API key. */
export const channelApi: PolpoApi = async (path, init) => {
  try {
    const headers = new Headers(init?.headers);
    if (init?.body) headers.set("Content-Type", "application/json");
    const res = await apiFetch(apiUrl(`/api/v1${path}`), { ...init, headers });
    return await res.json();
  } catch {
    return { ok: false, error: "Could not connect to server" };
  }
};

/** Secrets come back from the API masked ("••••1234"); saving them unchanged keeps the stored value. */
export function isMaskedSecret(value?: string): boolean {
  return !!value && value.includes("••••");
}
