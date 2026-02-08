/**
 * /memory — View and edit persistent project memory.
 * Memory content is injected into every agent's prompt for project context.
 */

import type { CommandContext } from "../context.js";
import { showTextarea } from "../widgets.js";

const MEMORY_TEMPLATE = `# Project Memory

## Architecture
<!-- Describe your tech stack, folder structure, key patterns -->

## Conventions
<!-- Coding conventions, naming rules, style guides -->

## Decisions
<!-- Key decisions and why they were made -->

## Notes
<!-- Anything agents should know about this project -->
`;

export async function cmdMemory(ctx: CommandContext): Promise<void> {
  const current = ctx.orchestrator.getMemory();
  const initial = current || MEMORY_TEMPLATE;

  const result = await showTextarea(ctx, {
    title: "{cyan-fg}Project Memory{/cyan-fg}",
    initial,
    borderColor: "cyan",
  });

  if (result === null) {
    // Cancelled
    return;
  }

  ctx.orchestrator.saveMemory(result);
  const lines = result.split("\n").filter(l => l.trim()).length;
  ctx.logAlways(`{cyan-fg}Project memory saved ({bold}${lines}{/bold} lines){/cyan-fg}`);
}
