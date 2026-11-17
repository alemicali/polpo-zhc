import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConversationCheckStore } from "../stores/file-conversation-check-store.js";
import { ConversationCheckManager } from "../core/conversation-check-manager.js";
import { CHECK_IN_INSTRUCTIONS, CHECK_IN_WHY, executeOrchestratorTool } from "../llm/orchestrator-tools.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function polpo() {
  const dir = mkdtempSync(join(tmpdir(), "polpo-check-ins-"));
  dirs.push(dir);
  const manager = new ConversationCheckManager(new FileConversationCheckStore(dir));
  const fake = {
    getConversationCheckManager: () => manager,
    resolveChatTarget: async (to: string) => ({ channel: "main", chatId: "-100", name: to, conversation: "telegram:group:-100" }),
  };
  return { manager, polpo: fake as any };
}

describe("Polpo's check-ins as the primary bot", () => {
  it("one recurring check with the check-in instructions, replaced when changed, cancelled when off", async () => {
    const { manager, polpo: p } = polpo();
    const origin = { channel: "main", chatId: "7", name: "Alessio" };
    const on = await executeOrchestratorTool("set_check_ins", { enabled: true, timezone: "Europe/Rome" }, p, { sessionId: "chat-1", origin });
    expect(on).toMatch(/^Check-ins on \(chk_[\w-]+\): cron "0 9,18 \* \* \*" Europe\/Rome, next .* to "Alessio"/);
    let active = await manager.list({ states: ["active"] });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ prompt: CHECK_IN_INSTRUCTIONS, why: CHECK_IN_WHY, cron: "0 9,18 * * *", target: origin });
    expect(CHECK_IN_INSTRUCTIONS).toContain("NO_UPDATE");

    await executeOrchestratorTool("set_check_ins", { enabled: true, cron: "0 8 * * 1-5", to: "Team" }, p, { sessionId: "chat-1", origin });
    active = await manager.list({ states: ["active"] });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ cron: "0 8 * * 1-5", target: { name: "Team" } });

    expect(await executeOrchestratorTool("set_check_ins", { enabled: false }, p, { sessionId: "chat-1" })).toBe("Check-ins turned off.");
    expect(await manager.list({ states: ["active"] })).toHaveLength(0);
    expect(await executeOrchestratorTool("set_check_ins", { enabled: true }, p, {})).toMatch(/need a conversation/);
  });
});
