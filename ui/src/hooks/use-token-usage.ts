import { useCallback, useEffect, useRef, useState } from "react";
import { useEvents } from "@polpo-ai/react";
import { apiUrl, config } from "@/lib/config";

export type TokenUsageRange = "today" | "24h" | "7d" | "30d" | "all";

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
  const { events } = useEvents(["token-usage:recorded", "agent:finished", "task:transition"], 1);
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
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const latestEventId = events.at(-1)?.id;
  const handledEventRef = useRef(latestEventId);
  useEffect(() => {
    if (!latestEventId || handledEventRef.current === latestEventId) return;
    handledEventRef.current = latestEventId;
    void refresh();
  }, [latestEventId, refresh]);

  return { usage, loading, refresh };
}
