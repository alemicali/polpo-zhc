import { useEffect, useState } from "react";
import { config } from "@/lib/config";

type AuthState = "loading" | "hidden" | "visible";

/**
 * Log out of the instance's sign-in: `available` only when the instance has a password (the
 * ⋯ menu in the header shows "Log out" then).
 */
export function useInstanceLogout(): { available: boolean; busy: boolean; logout: () => Promise<void> } {
  const [state, setState] = useState<AuthState>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`${config.baseUrl}/api/v1/auth/instance/status`, { credentials: "include" })
      .then((res) => res.json())
      .then((body) => {
        if (!alive) return;
        setState(body?.ok && body.data?.enabled ? "visible" : "hidden");
      })
      .catch(() => {
        if (alive) setState("hidden");
      });
    return () => { alive = false; };
  }, []);

  const logout = async () => {
    setBusy(true);
    try {
      await fetch(`${config.baseUrl}/api/v1/auth/instance/logout`, {
        method: "POST",
        credentials: "include",
      });
    } finally {
      window.location.assign("/login");
    }
  };

  return { available: state === "visible", busy, logout };
}
