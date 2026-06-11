/**
 * Email send REST endpoint — invoked by the chat UI after the user
 * confirms an `email_send` preview (the approval gate intercepts the
 * tool call in CHAT mode and emits an `email_preview` chunk; on
 * confirmation the UI POSTs here).
 *
 * Re-uses the exact same `sendEmail()` helper that the agent tool
 * `email_send` runs at task time, so the byte-for-byte SMTP behaviour
 * is identical: same vault > env resolution, same emailAllowedDomains
 * gate, same nodemailer config, same attachment sandboxing.
 *
 * Security model:
 * - emailAllowedDomains is enforced in `sendEmail()` itself — the
 *   preview UI is NOT a security boundary, only a UX gate. A bad-domain
 *   recipient that slipped past the preview is still rejected here.
 * - When `agent` is supplied we resolve that agent's vault + per-agent
 *   emailAllowedDomains override (mirrors createAllTools). When omitted
 *   (orchestrator path) we fall back to global config settings.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import type { Orchestrator } from "../../core/orchestrator.js";
import { resolveAgentVault } from "../../vault/index.js";
import { sendEmail, type SendEmailParams } from "../../tools/email-tools.js";

const recipientSchema = z.union([z.string(), z.array(z.string())]).optional();

const SendEmailSchema = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  subject: z.string(),
  body: z.string(),
  html: z.boolean().optional(),
  cc: recipientSchema,
  bcc: recipientSchema,
  from: z.string().optional(),
  reply_to: z.string().optional(),
  attachments: z.array(z.object({
    path: z.string(),
    filename: z.string().optional(),
  })).optional(),
  /** Optional agent name — when present the agent's vault + per-agent
   *  emailAllowedDomains override are used (parity with email_send when
   *  invoked in chat mode). Omitted = global config defaults. */
  agent: z.string().optional(),
});

export function emailRoutes(getDeps: () => {
  orchestrator: Orchestrator;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  app.post("/send", async (c) => {
    const parsed = SendEmailSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: parsed.error.issues.map(i => i.message).join("; ") }, 400);
    }
    const { agent, ...payload } = parsed.data;
    const { orchestrator } = getDeps();

    // Resolve scope: per-agent vault + emailAllowedDomains override
    // when `agent` is supplied (chat agent-direct mode). Otherwise fall
    // back to the global setting (orchestrator chat mode).
    let vault: ReturnType<typeof resolveAgentVault> | undefined;
    let emailAllowedDomains: string[] | undefined;
    if (agent) {
      const agents = await orchestrator.getAgents();
      const agentConfig = agents.find((a) => a.name === agent);
      if (!agentConfig) {
        return c.json({ ok: false, error: `Agent "${agent}" not found` }, 404);
      }
      const vaultEntries = await orchestrator.getVaultStore()?.getAllForAgent(agent);
      vault = resolveAgentVault(vaultEntries);
      emailAllowedDomains = agentConfig.emailAllowedDomains
        ?? orchestrator.getConfig()?.settings?.emailAllowedDomains;
    } else {
      emailAllowedDomains = orchestrator.getConfig()?.settings?.emailAllowedDomains;
    }

    const cwd = orchestrator.getAgentWorkDir();
    try {
      const result = await sendEmail(
        payload as SendEmailParams,
        cwd,
        undefined,
        vault,
        emailAllowedDomains,
      );
      return c.json({ ok: true, data: { id: result.messageId, ...result } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 400);
    }
  });

  return app;
}
