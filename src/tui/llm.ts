/**
 * LLM integration: Claude SDK query wrappers and YAML extraction.
 */

/** Progress callback for querySDK */
export type OnProgress = (event: string) => void;

/** Query Claude SDK for text-only response (no tools) */
export async function querySDKText(prompt: string, cwd: string): Promise<string> {
  return querySDK(prompt, [], cwd);
}

/** Query SDK with optional tool access */
export async function querySDK(
  prompt: string,
  allowedTools: string[],
  cwd: string,
  onProgress?: OnProgress,
): Promise<string> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  let resultText = "";
  const q = query({
    prompt,
    options: {
      cwd,
      permissionMode: "bypassPermissions" as any,
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      allowedTools,
    },
  });

  for await (const message of q) {
    if (message.type === "assistant" && (message as any).message) {
      const content = (message as any).message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            resultText = block.text;
            if (onProgress) {
              const firstLine = block.text.split("\n").find((l: string) => l.trim()) ?? "";
              if (firstLine.trim()) onProgress(firstLine.trim().slice(0, 120));
            }
          }
          if (block.type === "tool_use" && onProgress) {
            const toolName = block.name;
            const toolInput = block.input as Record<string, unknown> | undefined;
            if (toolName === "Bash") {
              const cmd = (toolInput?.command as string)?.slice(0, 80) ?? "";
              onProgress(`{cyan-fg}${toolName}{/cyan-fg} ${cmd}`);
            } else if (toolName === "Skill") {
              const skill = (toolInput?.skill as string) ?? "";
              onProgress(`{cyan-fg}Skill{/cyan-fg} ${skill}`);
            } else {
              onProgress(`{cyan-fg}${toolName}{/cyan-fg}`);
            }
          }
        }
      }
    }
    if (message.type === "result") {
      const result = message as any;
      if (result.subtype === "success" && result.result) {
        resultText = result.result;
      }
    }
  }

  return resultText.trim();
}

/** Extract YAML block from LLM response (handles markdown fences) */
export function extractYaml(text: string): string {
  let yaml = text.trim();
  const fenceMatch = yaml.match(/```(?:ya?ml)?\n([\s\S]*?)\n```/i);
  if (fenceMatch) {
    yaml = fenceMatch[1].trim();
  }
  if (!yaml.startsWith("tasks:") && !yaml.startsWith("team:")) {
    const teamIdx = yaml.indexOf("team:");
    const tasksIdx = yaml.indexOf("tasks:");
    if (teamIdx >= 0 && (tasksIdx < 0 || teamIdx < tasksIdx)) {
      yaml = yaml.slice(teamIdx);
    } else if (tasksIdx >= 0) {
      yaml = yaml.slice(tasksIdx);
    }
  }
  return yaml;
}

/** Extract team YAML block from LLM response */
export function extractTeamYaml(text: string): string {
  let yaml = text.trim();
  const fenceMatch = yaml.match(/```(?:ya?ml)?\n([\s\S]*?)\n```/i);
  if (fenceMatch) yaml = fenceMatch[1].trim();
  if (!yaml.startsWith("team:")) {
    const idx = yaml.indexOf("team:");
    if (idx >= 0) yaml = yaml.slice(idx);
  }
  return yaml;
}
