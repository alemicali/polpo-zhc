import { describe, it, expect } from "vitest";
import { buildReachabilitySection } from "../llm/prompts.js";

const CHANNELS = {
  "polpo-channel": { type: "telegram", gateway: { enableInbound: true, dmPolicy: "pairing" } },
  "health-coach": { type: "telegram", gateway: { enableInbound: true, dmPolicy: "pairing", agent: "health-coach" } },
  mobile: { type: "expo-push" },
  hooks: { type: "webhook" },
  mail: { type: "email" },
  alerts: { type: "telegram" },
};

describe("buildReachabilitySection", () => {
  const text = buildReachabilitySection(CHANNELS, new Map([["polpo-channel", "polpo_orchestrator_bot"], ["health-coach", "polpo_health_coach_bot"]]));

  it("lists inbound bots with their handle and target", () => {
    expect(text).toContain("Telegram @polpo_orchestrator_bot: talks to you; /agent NAME");
    expect(text).toContain("Telegram @polpo_health_coach_bot: dedicated to agent health-coach");
    expect(text).toContain("Accepts text, photos, documents, voice notes");
  });

  it("describes the HTTP API as the programmatic entry point", () => {
    expect(text).toContain("POST /v1/chat/completions");
    expect(text).toContain('"agent": "<name>"');
  });

  it("marks webhook, email, push and notify-only Telegram as outbound only", () => {
    const outbound = text.slice(text.indexOf("**Outbound only"));
    for (const name of ['"hooks" (webhook)', '"mail" (email)', '"mobile" (expo-push)', '"alerts" (telegram)']) {
      expect(outbound).toContain(name);
    }
    expect(outbound).not.toContain('"polpo-channel"');
    expect(text).toContain("forwarding an email to Polpo does nothing");
    expect(text).toContain("it does not expose one");
  });

  it("falls back to the channel name when the bot username is unknown", () => {
    expect(buildReachabilitySection(CHANNELS)).toContain('Telegram channel "health-coach": dedicated to agent health-coach');
  });

  it("works with no channels", () => {
    const empty = buildReachabilitySection({});
    expect(empty).toContain("Web chat of this instance");
    expect(empty).toContain("- none configured");
  });
});
