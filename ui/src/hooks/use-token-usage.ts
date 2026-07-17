import { useCallback, useEffect, useState } from "react";
import { apiUrl, config } from "@/lib/config";

export type TokenUsageRange = "24h" | "7d" | "30d" | "all";

export interface TokenUsageStats {
  range: TokenUsageRange;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  taskTokens: number;
  cost: number;
  calls: number;
}

export function useTokenUsage(range: TokenUsageRange) {
  const [usage, setUsage] = useState<TokenUsageStats | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const headers = config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined;
      const response = await fetch(apiUrl(`/api/v1/token-usage?range=${range}`), {
        headers,
        credentials: "include",
      });
      const payload = await response.json();
      if (response.ok && payload.ok) setUsage(payload.data);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { usage, loading, refresh };
}
