import { useEffect, useState } from "react";
import type { PolpoApi } from "@/components/config/telegram-connect";

export interface TelegramChannelInfo {
  /** Bot username from getMe, once verified. */
  botUsername?: string;
  /** Suggestions of the dedicated agent shown in the bot menu. */
  suggestionCount?: number;
}

/** Bot identity and menu size for a saved Telegram channel card. */
export function useTelegramChannelInfo(api: PolpoApi, channel: string, dedicatedAgent?: string): TelegramChannelInfo {
  const [info, setInfo] = useState<TelegramChannelInfo>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api(`/peers/telegram/verify?channel=${encodeURIComponent(channel)}`, { method: "POST", body: JSON.stringify({}) }),
      dedicatedAgent ? api("/agents") : Promise.resolve(undefined),
    ]).then(([bot, agents]) => {
      if (cancelled) return;
      const agent = agents?.ok
        ? ((agents.data ?? []) as { name: string; suggestions?: { title?: string; prompt?: string }[] }[]).find((a) => a.name === dedicatedAgent)
        : undefined;
      setInfo({
        botUsername: bot.ok ? (bot.data as { username: string }).username : undefined,
        suggestionCount: agent ? (agent.suggestions ?? []).filter((s) => s.title && s.prompt).length : undefined,
      });
    });
    return () => { cancelled = true; };
  }, [api, channel, dedicatedAgent]);
  return info;
}
