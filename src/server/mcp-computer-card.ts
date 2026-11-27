/**
 * The computer card (MCP App, widgets/computer-card): a remote computer's live view status, who
 * holds its desktop (the agent, or a person since when) and its agents' takeover requests, with
 * Take control / Give back. Built from the REST shapes (GET /computers/:id and /desktop); the text
 * form is what hosts without apps (and the model) read. Never carries the VNC password.
 */
import type { CardAppearance } from "./mcp-server/card-appearance.js";

export interface ComputerCardRequest {
  id: string;
  agent: string;
  reason: string;
  url?: string;
  whatToDo?: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  takenBy?: string;
  note?: string;
  taskId?: string;
}

export interface ComputerCard {
  kind: "computer";
  key: { createdAt: number; seq: number };
  generatedAt: string;
  computer: { id: string; name: string; kind: string; status: string };
  desktop: { state: string; startedAt?: string; note?: string; error?: string };
  control: { holder: "agent" | "person"; person?: string; since?: string; lastNote?: string };
  /** Open requests first, then the recent ones. */
  requests: ComputerCardRequest[];
  /** The computer's page in the dashboard (where the live view is). */
  link?: string;
  appearance?: CardAppearance;
}

export interface ComputerCardInput {
  computer: { id: string; name?: string; kind: string; status: string };
  desktop: { state: string; startedAt?: string; note?: string; error?: string };
  control: { holder: "agent" | "person"; person?: string; since?: string; lastNote?: string; requests?: ComputerCardRequest[] };
  key: { createdAt: number; seq: number };
  link?: string;
  /** Recent (closed) requests shown at most. */
  recent?: number;
}

const OPEN = new Set(["pending", "in_control"]);

export function buildComputerCard(i: ComputerCardInput): ComputerCard {
  const all = i.control.requests ?? [];
  const open = all.filter((r) => OPEN.has(r.status));
  const closed = all.filter((r) => !OPEN.has(r.status)).slice(0, i.recent ?? 5);
  const pick = (r: ComputerCardRequest): ComputerCardRequest => ({
    id: r.id, agent: r.agent, reason: r.reason, status: r.status, expiresAt: r.expiresAt, createdAt: r.createdAt,
    ...(r.url ? { url: r.url } : {}), ...(r.whatToDo ? { whatToDo: r.whatToDo } : {}), ...(r.takenBy ? { takenBy: r.takenBy } : {}),
    ...(r.note ? { note: r.note } : {}), ...(r.taskId ? { taskId: r.taskId } : {}),
  });
  return {
    kind: "computer",
    key: i.key,
    generatedAt: new Date().toISOString(),
    computer: { id: i.computer.id, name: i.computer.name || i.computer.id, kind: i.computer.kind, status: i.computer.status },
    desktop: {
      state: i.desktop.state,
      ...(i.desktop.startedAt ? { startedAt: i.desktop.startedAt } : {}), ...(i.desktop.note ? { note: i.desktop.note } : {}), ...(i.desktop.error ? { error: i.desktop.error } : {}),
    },
    control: {
      holder: i.control.holder,
      ...(i.control.person ? { person: i.control.person } : {}), ...(i.control.since ? { since: i.control.since } : {}), ...(i.control.lastNote ? { lastNote: i.control.lastNote } : {}),
    },
    requests: [...open, ...closed].map(pick),
    ...(i.link ? { link: i.link } : {}),
  };
}

export function computerCardText(c: ComputerCard): string {
  const lines = [
    `Computer ${c.computer.name} [${c.computer.id}] (${c.computer.kind}): ${c.computer.status}.`,
    `Live view: ${c.desktop.state === "running" ? `running${c.desktop.startedAt ? ` since ${c.desktop.startedAt}` : ""}` : c.desktop.state === "machine-off" ? "off (its machine is not running)" : c.desktop.state}.`,
    c.control.holder === "person"
      ? `${c.control.person ?? "A person"} has control since ${c.control.since ?? "?"}: the agent's browser waits.`
      : `The agent has control.${c.control.lastNote ? ` Last note from a person: ${c.control.lastNote}` : ""}`,
  ];
  const open = c.requests.filter((r) => OPEN.has(r.status));
  if (open.length) {
    lines.push("Waiting for a person:");
    for (const r of open) lines.push(`- ${r.agent}: ${r.reason}${r.url ? ` (page ${r.url})` : ""}${r.whatToDo ? `; to do: ${r.whatToDo}` : ""}; waits until ${r.expiresAt}${r.status === "in_control" ? ` (${r.takenBy ?? "a person"} has control)` : ""}`);
  }
  if (c.link) lines.push(`Live view: ${c.link}`);
  return lines.join("\n");
}
