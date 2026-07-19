import { useCallback, useEffect, useState } from "react";
import { apiUrl, config } from "@/lib/config";

export type AppRuntime = {
  key: string;
  kind: "service" | "deployment";
  appId: string;
  resourceId: string;
  status: "stopped" | "starting" | "running" | "succeeded" | "failed" | "cancelled";
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  logs: Array<{ seq: number; at: string; stream: "stdout" | "stderr" | "system"; text: string }>;
};

export type AppService = {
  id: string; name: string; kind: "frontend" | "backend" | "worker" | "database"; command: string;
  cwd?: string; port?: number; healthPath?: string; publicUrl?: string; autoStart?: boolean;
};
export type AppDeployment = {
  id: string; name: string; environment: AppEnvironment; command: string; cwd?: string; provider?: string;
  url?: string; branch?: string; lastRun?: { status: string; startedAt?: string; finishedAt?: string; exitCode?: number; error?: string };
};
export type AppDomain = {
  id: string; hostname: string; environment: AppEnvironment; deploymentId?: string;
  expectedRecords: Array<{ type: "A" | "AAAA" | "CNAME" | "TXT"; name: string; value: string }>;
  verification: { status: "unchecked" | "valid" | "invalid"; checkedAt?: string; details?: string[]; httpOk?: boolean };
};
export type AppEnvironment = "development" | "preview" | "staging" | "production";
export type RegisteredApp = {
  id: string; name: string; slug: string; description?: string; localPath: string;
  repository?: { url: string; branch?: string }; framework?: string; tags: string[];
  screenshotUpdatedAt?: string;
  services: AppService[]; deployments: AppDeployment[]; domains: AppDomain[]; runtime: AppRuntime[];
  createdAt: string; updatedAt: string;
};
export type AppInput = Omit<RegisteredApp, "id" | "createdAt" | "updatedAt" | "runtime">;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
  const response = await fetch(apiUrl(`/api/v1/apps${path}`), { ...init, headers, credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) throw new Error(body?.error || `Apps request failed (${response.status})`);
  return body.data as T;
}

export function useApps(selectedId?: string) {
  const [apps, setApps] = useState<RegisteredApp[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const data = await request<RegisteredApp[]>("");
      setApps(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
    const interval = window.setInterval(() => void refetch(true), 3_000);
    return () => window.clearInterval(interval);
  }, [refetch]);

  const create = useCallback(async (input: AppInput) => {
    const result = await request<RegisteredApp>("", { method: "POST", body: JSON.stringify(input) });
    await refetch(true);
    return result;
  }, [refetch]);
  const update = useCallback(async (id: string, input: AppInput) => {
    const result = await request<RegisteredApp>(`/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) });
    await refetch(true);
    return result;
  }, [refetch]);
  const remove = useCallback(async (id: string) => {
    await request<void>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refetch(true);
  }, [refetch]);
  const serviceAction = useCallback(async (appId: string, serviceId: string, action: "start" | "stop" | "restart") => {
    await request(`/${encodeURIComponent(appId)}/services/${encodeURIComponent(serviceId)}/${action}`, { method: "POST" });
    await refetch(true);
  }, [refetch]);
  const appAction = useCallback(async (appId: string, action: "start" | "stop" | "restart") => {
    await request(`/${encodeURIComponent(appId)}/lifecycle/${action}`, { method: "POST" });
    await refetch(true);
  }, [refetch]);
  const captureScreenshot = useCallback(async (appId: string, url?: string) => {
    await request(`/${encodeURIComponent(appId)}/screenshot`, { method: "POST", body: JSON.stringify({ url }) });
    await refetch(true);
  }, [refetch]);
  const deploymentAction = useCallback(async (appId: string, deploymentId: string, action: "run" | "stop") => {
    await request(`/${encodeURIComponent(appId)}/deployments/${encodeURIComponent(deploymentId)}/${action}`, { method: "POST" });
    await refetch(true);
  }, [refetch]);
  const verifyDomain = useCallback(async (appId: string, domainId: string) => {
    await request(`/${encodeURIComponent(appId)}/domains/${encodeURIComponent(domainId)}/verify`, { method: "POST" });
    await refetch(true);
  }, [refetch]);
  const probeService = useCallback((appId: string, serviceId: string) =>
    request<{ url: string; ok: boolean; status?: number; latencyMs: number; error?: string }>(
      `/${encodeURIComponent(appId)}/services/${encodeURIComponent(serviceId)}/health`,
    ), []);

  return {
    apps,
    app: apps.find((item) => item.id === selectedId || item.slug === selectedId),
    isLoading,
    error,
    refetch,
    create,
    update,
    remove,
    serviceAction,
    appAction,
    captureScreenshot,
    deploymentAction,
    verifyDomain,
    probeService,
  };
}
