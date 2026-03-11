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

// ─── phone_setup_inbound ───

const PhoneSetupInboundSchema = Type.Object({
  instructions: Type.String({ description: "System prompt for the inbound assistant — how to greet callers, what to ask, how to handle different scenarios" }),
  firstMessage: Type.Optional(Type.String({ description: "First message when answering (e.g. 'Hello, thank you for calling Acme Corp. How can I help you?')" })),
  voice: Type.Optional(Type.String({ description: "Voice ID (e.g. '11labs:sarah'). Default: VAPI default voice" })),
  maxDuration: Type.Optional(Type.Number({ description: "Maximum call duration in seconds (default: 600, max: 1800)" })),
  record: Type.Optional(Type.Boolean({ description: "Record inbound calls (default: true)" })),
  name: Type.Optional(Type.String({ description: "Name for the inbound assistant (default: 'Polpo Inbound Assistant')" })),
});

function createPhoneSetupInboundTool(vault?: ResolvedVault): AgentTool<typeof PhoneSetupInboundSchema> {
  return {
    name: "phone_setup_inbound",
    label: "Setup Inbound Calls",
    description:
      "Configure the AI assistant that answers incoming phone calls on your VAPI number. " +
      "Creates a persistent assistant with your instructions and assigns it to the phone number. " +
      "After setup, any call to your number will be answered by the AI. " +
      "Call this again with different instructions to update the inbound behavior.",
    parameters: PhoneSetupInboundSchema,
    async execute(_toolCallId, params, signal) {
      const apiKey = getVapiApiKey(vault);
      if (!apiKey) {
        return err("Error: VAPI_API_KEY not found. Add it to vault (service: vapi, key: api_key) or set as environment variable.");
      }

      const phoneNumberId = getVapiPhoneNumberId(vault);
      if (!phoneNumberId) {
        return err("Error: VAPI_PHONE_NUMBER_ID not found. Add it to vault (service: vapi, key: phone_number_id) or set as environment variable.");
      }

      const maxDuration = Math.min(params.maxDuration ?? DEFAULT_MAX_DURATION, 1800);
      const shouldRecord = params.record !== false;
      const assistantName = params.name ?? "Polpo Inbound Assistant";

      let voiceConfig: Record<string, unknown> | undefined;
      if (params.voice) {
        const [provider, voiceId] = params.voice.includes(":")
          ? params.voice.split(":", 2)
          : ["vapi", params.voice];
        voiceConfig = { provider, voiceId };
      }

      try {
        // Step 1: Check if there's already an assistant on the number
        const phoneRes = await vapiRequest("GET", `/phone-number/${phoneNumberId}`, apiKey, undefined, signal);
        if (!phoneRes.ok) {
          return err(`Error fetching phone number: VAPI returned ${phoneRes.status}`);
        }

        const existingAssistantId = phoneRes.data.assistantId as string | undefined;

        // Step 2: Create or update the assistant
        const assistantBody: Record<string, unknown> = {
          name: assistantName,
          model: {
            provider: "openai",
            model: "gpt-4o",
            messages: [{ role: "system", content: params.instructions }],
          },
          ...(params.firstMessage ? { firstMessage: params.firstMessage } : { firstMessage: "Hello, how can I help you?" }),
          ...(voiceConfig ? { voice: voiceConfig } : {}),
          firstMessageMode: "assistant-speaks-first",
          maxDurationSeconds: maxDuration,
          backgroundSound: "office",
          voicemailDetection: "off",
          analysisPlan: {
            summaryPlan: { enabled: true },
            successEvaluationPlan: { enabled: true },
          },
          artifactPlan: {
            recordingEnabled: shouldRecord,
          },
        };

        let assistantId: string;

        if (existingAssistantId) {
          // Update existing assistant
          const updateRes = await vapiRequest("PATCH", `/assistant/${existingAssistantId}`, apiKey, assistantBody, signal);
          if (!updateRes.ok) {
            return err(`Error updating assistant: VAPI returned ${updateRes.status}: ${JSON.stringify(updateRes.data)}`);
          }
          assistantId = existingAssistantId;
        } else {
          // Create new assistant
          const createRes = await vapiRequest("POST", "/assistant", apiKey, assistantBody, signal);
          if (!createRes.ok) {
            return err(`Error creating assistant: VAPI returned ${createRes.status}: ${JSON.stringify(createRes.data)}`);
          }
          assistantId = createRes.data.id as string;

          // Step 3: Assign to phone number
          // We need to know the provider to PATCH — get it from the phone number data
          const provider = phoneRes.data.provider as string ?? "twilio";
          const patchRes = await vapiRequest("PATCH", `/phone-number/${phoneNumberId}`, apiKey, {
            provider,
            assistantId,
          }, signal);

          if (!patchRes.ok) {
            return err(`Error assigning assistant to phone number: VAPI returned ${patchRes.status}: ${JSON.stringify(patchRes.data)}`);
          }
        }

        const number = phoneRes.data.number ?? phoneRes.data.sipUri ?? phoneNumberId;
        return ok(
          `Inbound assistant configured on ${number}:\n` +
          `- **Assistant ID:** ${assistantId}\n` +
          `- **Name:** ${assistantName}\n` +
          `- **Max duration:** ${maxDuration}s\n` +
          `- **Recording:** ${shouldRecord ? "enabled" : "disabled"}\n\n` +
          `Any incoming calls to this number will now be answered by the AI assistant.`,
          { assistantId, phoneNumberId, number },
        );
      } catch (e: any) {
        return err(`Error setting up inbound: ${e.message}`);
      }
    },
  };
}

// ─── phone_get_inbound_config ───

const PhoneGetInboundConfigSchema = Type.Object({});

function createPhoneGetInboundConfigTool(vault?: ResolvedVault): AgentTool<typeof PhoneGetInboundConfigSchema> {
  return {
    name: "phone_get_inbound_config",
    label: "Get Inbound Config",
    description: "Get the current inbound call configuration for your VAPI phone number. Shows the assigned assistant, voice, instructions, and other settings.",
    parameters: PhoneGetInboundConfigSchema,
    async execute(_toolCallId, _params, signal) {
      const apiKey = getVapiApiKey(vault);
      if (!apiKey) {
        return err("Error: VAPI_API_KEY not found.");
      }

      const phoneNumberId = getVapiPhoneNumberId(vault);
      if (!phoneNumberId) {
        return err("Error: VAPI_PHONE_NUMBER_ID not found.");
      }

      try {
        // Get phone number details
        const phoneRes = await vapiRequest("GET", `/phone-number/${phoneNumberId}`, apiKey, undefined, signal);
        if (!phoneRes.ok) {
          return err(`Error: VAPI returned ${phoneRes.status}`);
        }

        const phone = phoneRes.data;
        const number = phone.number ?? phone.sipUri ?? phoneNumberId;
        const parts: string[] = [];

        parts.push(`**Phone Number:** ${number}`);
        parts.push(`**Status:** ${phone.status ?? "unknown"}`);
        parts.push(`**Provider:** ${phone.provider ?? "unknown"}`);

        if (!phone.assistantId) {
          parts.push(`\n**Inbound:** Not configured — calls will not be answered by AI.`);
          parts.push(`Use phone_setup_inbound to configure an AI assistant for incoming calls.`);
          return ok(parts.join("\n"), { phoneNumberId, number, configured: false });
        }

        parts.push(`**Assistant ID:** ${phone.assistantId}`);

        // Get assistant details
        const assistantRes = await vapiRequest("GET", `/assistant/${phone.assistantId}`, apiKey, undefined, signal);
        if (assistantRes.ok) {
          const asst = assistantRes.data;
          parts.push(`**Assistant Name:** ${asst.name ?? "unnamed"}`);

          if (asst.model?.messages?.[0]?.content) {
            const instructions = asst.model.messages[0].content as string;
            const truncated = instructions.length > 500 ? instructions.slice(0, 500) + "..." : instructions;
            parts.push(`**Instructions:**\n${truncated}`);
          }

          if (asst.firstMessage) {
            parts.push(`**First Message:** ${asst.firstMessage}`);
          }

          if (asst.voice) {
            parts.push(`**Voice:** ${asst.voice.provider ?? "default"}:${asst.voice.voiceId ?? "default"}`);
          }

          parts.push(`**Max Duration:** ${asst.maxDurationSeconds ?? 600}s`);
          parts.push(`**Recording:** ${asst.artifactPlan?.recordingEnabled !== false ? "enabled" : "disabled"}`);
        }

        return ok(parts.join("\n"), { phoneNumberId, number, assistantId: phone.assistantId, configured: true });
      } catch (e: any) {
        return err(`Error getting inbound config: ${e.message}`);
      }
    },
  };
}

// ─── phone_disable_inbound ───

const PhoneDisableInboundSchema = Type.Object({});

function createPhoneDisableInboundTool(vault?: ResolvedVault): AgentTool<typeof PhoneDisableInboundSchema> {
  return {
    name: "phone_disable_inbound",
    label: "Disable Inbound Calls",
    description: "Disable the AI assistant for incoming calls on your VAPI phone number. Calls will no longer be answered by the AI. The assistant is deleted.",
    parameters: PhoneDisableInboundSchema,
    async execute(_toolCallId, _params, signal) {
      const apiKey = getVapiApiKey(vault);
      if (!apiKey) {
        return err("Error: VAPI_API_KEY not found.");
      }

      const phoneNumberId = getVapiPhoneNumberId(vault);
      if (!phoneNumberId) {
        return err("Error: VAPI_PHONE_NUMBER_ID not found.");
      }

      try {
        // Get current phone number config
        const phoneRes = await vapiRequest("GET", `/phone-number/${phoneNumberId}`, apiKey, undefined, signal);
        if (!phoneRes.ok) {
          return err(`Error: VAPI returned ${phoneRes.status}`);
        }

        const assistantId = phoneRes.data.assistantId as string | undefined;
        if (!assistantId) {
          return ok("Inbound is already disabled — no assistant is assigned to this phone number.");
        }

        // Remove assistant from phone number
        const provider = phoneRes.data.provider as string ?? "twilio";
        const patchRes = await vapiRequest("PATCH", `/phone-number/${phoneNumberId}`, apiKey, {
          provider,
          assistantId: null,
        }, signal);

        if (!patchRes.ok) {
          return err(`Error removing assistant from phone number: VAPI returned ${patchRes.status}`);
        }

        // Delete the assistant
        await vapiRequest("DELETE", `/assistant/${assistantId}`, apiKey, undefined, signal);

        const number = phoneRes.data.number ?? phoneRes.data.sipUri ?? phoneNumberId;
        return ok(
          `Inbound disabled on ${number}. Assistant ${assistantId} removed and deleted.\n` +
          `Incoming calls will no longer be answered by AI.`,
          { phoneNumberId, number, deletedAssistantId: assistantId },
        );
      } catch (e: any) {
        return err(`Error disabling inbound: ${e.message}`);
      }
    },
  };
}

// ─── Factory ───

export type PhoneToolName =
  | "phone_call" | "phone_get_call" | "phone_list_calls" | "phone_hangup"
  | "phone_setup_inbound" | "phone_get_inbound_config" | "phone_disable_inbound";

export const ALL_PHONE_TOOL_NAMES: readonly PhoneToolName[] = [
  "phone_call", "phone_get_call", "phone_list_calls", "phone_hangup",
  "phone_setup_inbound", "phone_get_inbound_config", "phone_disable_inbound",
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
    phone_setup_inbound: () => createPhoneSetupInboundTool(vault),
    phone_get_inbound_config: () => createPhoneGetInboundConfigTool(vault),
    phone_disable_inbound: () => createPhoneDisableInboundTool(vault),
  };

  const names = allowedTools
    ? ALL_PHONE_TOOL_NAMES.filter((n) => allowedTools.some((a) => a.toLowerCase() === n))
    : [...ALL_PHONE_TOOL_NAMES];

  return names.map((n) => factories[n]());
}
