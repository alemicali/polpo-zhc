/**
 * Phone call tools powered by VAPI (vapi.ai).
 *
 * Provides AI-driven phone call capabilities: make outbound calls with
 * natural language instructions, list recent calls, get call details
 * (transcript, summary, recording), and hang up active calls.
 *
 * Requires VAPI_API_KEY and VAPI_PHONE_NUMBER_ID in vault or environment.
 *
 * Tools:
 *   - phone_call:       Make an outbound phone call with AI assistant
 *   - phone_get_call:   Get details of a specific call (transcript, summary, recording)
 *   - phone_list_calls: List recent phone calls with status
 *   - phone_hangup:     Terminate an active phone call
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ResolvedVault } from "../vault/index.js";

const VAPI_BASE = "https://api.vapi.ai";
const DEFAULT_MAX_DURATION = 600; // 10 minutes
const POLL_INTERVAL = 5000; // 5 seconds
const MAX_POLL_TIME = 15 * 60 * 1000; // 15 minutes

// ─── Helpers ───

function getVapiApiKey(vault?: ResolvedVault): string | undefined {
  return vault?.getKey("vapi", "api_key") ?? process.env.VAPI_API_KEY;
}

function getVapiPhoneNumberId(vault?: ResolvedVault): string | undefined {
  return vault?.getKey("vapi", "phone_number_id") ?? process.env.VAPI_PHONE_NUMBER_ID;
}

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], details: { error: true } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface VapiCall {
  id: string;
  orgId?: string;
  type?: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  cost?: number;
  analysis?: {
    summary?: string;
    structuredData?: unknown;
    successEvaluation?: string;
  };
  artifact?: {
    transcript?: string;
    messages?: Array<{
      role: string;
      message: string;
      time?: number;
      secondsFromStart?: number;
    }>;
    recordingUrl?: string;
    stereoRecordingUrl?: string;
  };
  customer?: {
    number?: string;
    name?: string;
  };
  assistant?: {
    name?: string;
  };
}

async function vapiRequest(
  method: string,
  path: string,
  apiKey: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function formatDuration(startedAt?: string, endedAt?: string): string {
  if (!startedAt || !endedAt) return "unknown";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function formatEndedReason(reason?: string): string {
  if (!reason) return "unknown";
  const map: Record<string, string> = {
    "customer-ended-call": "Customer hung up",
    "assistant-ended-call": "Assistant ended the call",
    "assistant-said-end-call-phrase": "End-call phrase triggered",
    "customer-did-not-answer": "No answer",
    "customer-busy": "Line busy",
    "exceeded-max-duration": "Max duration exceeded",
    "silence-timed-out": "Silence timeout",
    "voicemail": "Went to voicemail",
    "assistant-forwarded-call": "Call transferred",
    "manually-canceled": "Manually canceled",
  };
  return map[reason] ?? reason;
}

function formatCallResult(call: VapiCall): string {
  const parts: string[] = [];

  parts.push(`**Call ID:** ${call.id}`);
  parts.push(`**Status:** ${call.status}`);

  if (call.customer?.number) {
    parts.push(`**Number:** ${call.customer.number}${call.customer.name ? ` (${call.customer.name})` : ""}`);
  }

  if (call.endedReason) {
    parts.push(`**Ended:** ${formatEndedReason(call.endedReason)}`);
  }

  parts.push(`**Duration:** ${formatDuration(call.startedAt, call.endedAt)}`);

  if (call.cost !== undefined) {
    parts.push(`**Cost:** $${call.cost.toFixed(4)}`);
  }

  if (call.analysis?.summary) {
    parts.push(`\n**Summary:**\n${call.analysis.summary}`);
  }

  if (call.artifact?.transcript) {
    const transcript = call.artifact.transcript.length > 3000
      ? call.artifact.transcript.slice(0, 3000) + "\n... (truncated)"
      : call.artifact.transcript;
    parts.push(`\n**Transcript:**\n${transcript}`);
  }

  if (call.artifact?.recordingUrl) {
    parts.push(`\n**Recording:** ${call.artifact.recordingUrl}`);
  }

  if (call.analysis?.successEvaluation) {
    parts.push(`**Success:** ${call.analysis.successEvaluation}`);
  }

  return parts.join("\n");
}

// ─── phone_call ───

const PhoneCallSchema = Type.Object({
  number: Type.String({ description: "Phone number to call (E.164 format with country code, e.g. '+14155551234' or '+393381234567')" }),
  instructions: Type.String({ description: "Natural language instructions for the AI assistant — what to say, what to ask, what information to collect" }),
  firstMessage: Type.Optional(Type.String({ description: "First message the assistant says when the call connects (e.g. 'Hi, this is Sara from Acme Corp.')" })),
  customerName: Type.Optional(Type.String({ description: "Name of the person being called (for context)" })),
  maxDuration: Type.Optional(Type.Number({ description: `Maximum call duration in seconds (default: ${DEFAULT_MAX_DURATION}, max: 1800)` })),
  voice: Type.Optional(Type.String({ description: "Voice ID for TTS (default: VAPI default voice). Use provider:voiceId format (e.g. '11labs:sarah')" })),
  record: Type.Optional(Type.Boolean({ description: "Record the call (default: true)" })),
  wait: Type.Optional(Type.Boolean({ description: "Wait for the call to complete and return transcript (default: true). Set to false to return immediately with just the call ID." })),
});

function createPhoneCallTool(vault?: ResolvedVault): AgentTool<typeof PhoneCallSchema> {
  return {
    name: "phone_call",
    label: "Make Phone Call",
    description:
      "Make an outbound AI phone call. The AI assistant calls the specified number, follows your instructions, " +
      "and returns a transcript and summary when done. Use this for scheduling, follow-ups, surveys, notifications, " +
      "or any conversation that needs to happen over the phone. WARNING: This is an irreversible side effect — it will actually call the phone number.",
    parameters: PhoneCallSchema,
    async execute(_toolCallId, params, signal) {
      const apiKey = getVapiApiKey(vault);
      if (!apiKey) {
        return err("Error: VAPI_API_KEY not found. Add it to vault (service: vapi, key: api_key) or set as environment variable.");
      }

      const phoneNumberId = getVapiPhoneNumberId(vault);
      if (!phoneNumberId) {
        return err("Error: VAPI_PHONE_NUMBER_ID not found. Add it to vault (service: vapi, key: phone_number_id) or set as environment variable. Buy a phone number at dashboard.vapi.ai first.");
      }

      const maxDuration = Math.min(params.maxDuration ?? DEFAULT_MAX_DURATION, 1800);
      const shouldWait = params.wait !== false;
      const shouldRecord = params.record !== false;

      // Build voice config
      let voiceConfig: Record<string, unknown> | undefined;
      if (params.voice) {
        const [provider, voiceId] = params.voice.includes(":")
          ? params.voice.split(":", 2)
          : ["vapi", params.voice];
        voiceConfig = { provider, voiceId };
      }

      // Build the call request with transient assistant
      const callBody: Record<string, unknown> = {
        phoneNumberId,
        customer: {
          number: params.number,
          ...(params.customerName ? { name: params.customerName } : {}),
        },
        assistant: {
          model: {
            provider: "openai",
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: params.instructions,
              },
            ],
          },
          ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
          ...(voiceConfig ? { voice: voiceConfig } : {}),
          maxDurationSeconds: maxDuration,
          backgroundSound: "office",
          voicemailDetection: {
            provider: "google",
            type: "audio",
            beepMaxAwaitSeconds: 20,
          },
          analysisPlan: {
            summaryPlan: { enabled: true },
            successEvaluationPlan: { enabled: true },
          },
          artifactPlan: {
            recordingEnabled: shouldRecord,
          },
        },
      };

      try {
        const { ok: isOk, status, data } = await vapiRequest("POST", "/call", apiKey, callBody, signal);

        if (!isOk) {
          return err(`Error: VAPI API returned ${status}: ${JSON.stringify(data)}`);
        }

        const callId = data.id as string;

        if (!shouldWait) {
          return ok(
            `Call initiated to ${params.number} (ID: ${callId}). Use phone_get_call to check status and get transcript.`,
            { callId, status: data.status },
          );
        }

        // Poll until call ends
        const pollStart = Date.now();
        let lastStatus = data.status as string;

        while (Date.now() - pollStart < MAX_POLL_TIME) {
          if (signal?.aborted) {
            return ok(
              `Call ${callId} still in progress (aborted by agent). Use phone_get_call to check later.\nLast status: ${lastStatus}`,
              { callId, status: lastStatus },
            );
          }

          await sleep(POLL_INTERVAL);

          const poll = await vapiRequest("GET", `/call/${callId}`, apiKey, undefined, signal);
          if (!poll.ok) continue;

          const call = poll.data as VapiCall;
          lastStatus = call.status;

          if (call.status === "ended") {
            return ok(formatCallResult(call), {
              callId: call.id,
              status: call.status,
              endedReason: call.endedReason,
              duration: formatDuration(call.startedAt, call.endedAt),
              transcript: call.artifact?.transcript,
              summary: call.analysis?.summary,
              recordingUrl: call.artifact?.recordingUrl,
              cost: call.cost,
            });
          }
        }

        // Polling timed out
        return ok(
          `Call ${callId} is still active after ${MAX_POLL_TIME / 60000} minutes. Use phone_get_call to check later.\nLast status: ${lastStatus}`,
          { callId, status: lastStatus, timedOut: true },
        );
      } catch (e: any) {
        return err(`Error making phone call: ${e.message}`);
      }
    },
  };
}

// ─── phone_get_call ───

const PhoneGetCallSchema = Type.Object({
  callId: Type.String({ description: "VAPI call ID to get details for" }),
});

function createPhoneGetCallTool(vault?: ResolvedVault): AgentTool<typeof PhoneGetCallSchema> {
  return {
    name: "phone_get_call",
    label: "Get Call Details",
    description:
      "Get details of a specific phone call including transcript, summary, recording URL, duration, and cost. " +
      "Use this to check the result of a call initiated with phone_call (especially if wait was set to false).",
    parameters: PhoneGetCallSchema,
    async execute(_toolCallId, params, signal) {
      const apiKey = getVapiApiKey(vault);
      if (!apiKey) {
        return err("Error: VAPI_API_KEY not found. Add it to vault (service: vapi, key: api_key) or set as environment variable.");
      }

      try {
        const { ok: isOk, status, data } = await vapiRequest("GET", `/call/${params.callId}`, apiKey, undefined, signal);

        if (!isOk) {
          return err(`Error: VAPI API returned ${status}: ${JSON.stringify(data)}`);
        }

        return ok(formatCallResult(data as VapiCall), {
          callId: data.id,
          status: data.status,
          endedReason: data.endedReason,
          transcript: data.artifact?.transcript,
          summary: data.analysis?.summary,
          recordingUrl: data.artifact?.recordingUrl,
          cost: data.cost,
        });
      } catch (e: any) {
        return err(`Error getting call details: ${e.message}`);
      }
    },
  };
}

// ─── phone_list_calls ───

const PhoneListCallsSchema = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Maximum number of calls to return (default: 10, max: 100)" })),
  status: Type.Optional(Type.String({ description: "Filter by status: queued, ringing, in-progress, ended" })),
});

function createPhoneListCallsTool(vault?: ResolvedVault): AgentTool<typeof PhoneListCallsSchema> {
  return {
    name: "phone_list_calls",
    label: "List Phone Calls",
    description: "List recent phone calls with their status, duration, and summary. Use this to review call history or find specific call IDs.",
    parameters: PhoneListCallsSchema,
    async execute(_toolCallId, params, signal) {
      const apiKey = getVapiApiKey(vault);
      if (!apiKey) {
        return err("Error: VAPI_API_KEY not found. Add it to vault (service: vapi, key: api_key) or set as environment variable.");
      }

      const limit = Math.min(params.limit ?? 10, 100);

      try {
        const { ok: isOk, status, data } = await vapiRequest("GET", `/call?limit=${limit}`, apiKey, undefined, signal);

        if (!isOk) {
          return err(`Error: VAPI API returned ${status}: ${JSON.stringify(data)}`);
        }

        let calls = (Array.isArray(data) ? data : data.calls ?? []) as VapiCall[];

        if (params.status) {
          calls = calls.filter((c) => c.status === params.status);
        }

        if (calls.length === 0) {
          return ok("No phone calls found.");
        }

        const lines = calls.map((c) => {
          const number = c.customer?.number ?? "unknown";
          const duration = formatDuration(c.startedAt, c.endedAt);
          const reason = c.endedReason ? ` — ${formatEndedReason(c.endedReason)}` : "";
          const summary = c.analysis?.summary ? `\n    Summary: ${c.analysis.summary.slice(0, 150)}` : "";
          return `- **${c.id}** | ${c.status} | ${number} | ${duration}${reason}${summary}`;
        });

        return ok(
          `${calls.length} call(s):\n\n${lines.join("\n\n")}`,
          { count: calls.length },
        );
      } catch (e: any) {
        return err(`Error listing calls: ${e.message}`);
      }
    },
  };
}

// ─── phone_hangup ───

const PhoneHangupSchema = Type.Object({
  callId: Type.String({ description: "VAPI call ID to terminate" }),
});

function createPhoneHangupTool(vault?: ResolvedVault): AgentTool<typeof PhoneHangupSchema> {
  return {
    name: "phone_hangup",
    label: "Hang Up Call",
    description: "Terminate an active phone call. Use this to end a call that is currently in progress. WARNING: This will immediately disconnect the call.",
    parameters: PhoneHangupSchema,
    async execute(_toolCallId, params, signal) {
      const apiKey = getVapiApiKey(vault);
      if (!apiKey) {
        return err("Error: VAPI_API_KEY not found. Add it to vault (service: vapi, key: api_key) or set as environment variable.");
      }

      try {
        const { ok: isOk, status, data } = await vapiRequest("DELETE", `/call/${params.callId}`, apiKey, undefined, signal);

        if (!isOk) {
          return err(`Error: VAPI API returned ${status}: ${JSON.stringify(data)}`);
        }

        return ok(`Call ${params.callId} terminated.`, { callId: params.callId });
      } catch (e: any) {
        return err(`Error hanging up call: ${e.message}`);
      }
    },
  };
}

// ─── Factory ───

export type PhoneToolName = "phone_call" | "phone_get_call" | "phone_list_calls" | "phone_hangup";

export const ALL_PHONE_TOOL_NAMES: readonly PhoneToolName[] = [
  "phone_call", "phone_get_call", "phone_list_calls", "phone_hangup",
];

/**
 * Create VAPI-powered phone call tools.
 *
 * @param vault - Resolved vault credentials (looks for VAPI_API_KEY, VAPI_PHONE_NUMBER_ID)
 * @param allowedTools - Optional filter
 */
export function createPhoneTools(
  vault?: ResolvedVault,
  allowedTools?: string[],
): AgentTool<any>[] {
  const factories: Record<PhoneToolName, () => AgentTool<any>> = {
    phone_call: () => createPhoneCallTool(vault),
    phone_get_call: () => createPhoneGetCallTool(vault),
    phone_list_calls: () => createPhoneListCallsTool(vault),
    phone_hangup: () => createPhoneHangupTool(vault),
  };

  const names = allowedTools
    ? ALL_PHONE_TOOL_NAMES.filter((n) => allowedTools.some((a) => a.toLowerCase() === n))
    : [...ALL_PHONE_TOOL_NAMES];

  return names.map((n) => factories[n]());
}
