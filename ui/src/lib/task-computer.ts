/**
 * Task computer choice helpers (Task.sandbox.computer), shared by the task page select and its tests.
 * Kept out of the component file so React fast refresh only sees components there.
 */
/** The value of "Agent default" in the select (never a computer id: ids are lowercase). */
export const AGENT_DEFAULT = "__agent_default__";
export const HOST_COMPUTER_ID = "host";
export const EPHEMERAL_COMPUTER = "ephemeral";

export interface TaskComputerAgent {
  name: string;
  computers?: string[];
  defaultComputer?: string;
}

export interface TaskComputerOption {
  value: string;
  label: string;
}

/**
 * What the select offers for a task of this agent: its default first, then its computers
 * ("host" is this server) and a fresh sandbox; a computer the task already names but the agent
 * no longer has stays listed (marked) so the select shows the truth.
 */
export function taskComputerOptions(
  agent: TaskComputerAgent | undefined,
  computers: ReadonlyArray<{ id: string; name: string }>,
  current?: string,
): TaskComputerOption[] {
  const nameOf = (id: string) => id === HOST_COMPUTER_ID ? "This server" : computers.find((c) => c.id === id)?.name ?? id;
  const def = agent?.defaultComputer || HOST_COMPUTER_ID;
  const ids = [...new Set([HOST_COMPUTER_ID, ...(agent?.computers ?? []), ...(agent?.defaultComputer ? [agent.defaultComputer] : [])])];
  const options: TaskComputerOption[] = [
    { value: AGENT_DEFAULT, label: `Agent default (${nameOf(def)})` },
    ...ids.map((id) => ({ value: id, label: id === HOST_COMPUTER_ID ? "This server" : `${nameOf(id)}${nameOf(id) !== id ? ` · ${id}` : ""}` })),
    { value: EPHEMERAL_COMPUTER, label: "Fresh sandbox (ephemeral)" },
  ];
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: `${nameOf(current)} (not one of the agent's computers)` });
  return options;
}

/** The task's sandbox with its computer set, or dropped (null when nothing else is left). */
export function sandboxWithComputer(sandbox: Record<string, unknown> | undefined, value: string): Record<string, unknown> | null {
  const { computer: _previous, ...others } = sandbox ?? {};
  if (value !== AGENT_DEFAULT) return { ...others, computer: value };
  return Object.keys(others).length ? others : null;
}
