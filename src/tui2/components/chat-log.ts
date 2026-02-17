import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export class ChatLog extends Container {
  private toolById = new Map<string, ToolExecutionComponent>();
  private streamingRuns = new Map<string, AssistantMessageComponent>();
  private toolsExpanded = false;

  /** Clear all messages and reset state */
  clearAll(): void {
    this.clear();
    this.toolById.clear();
    this.streamingRuns.clear();
  }

  /** Add a system message (dim italic) */
  addSystem(text: string): void {
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.system(text), 1, 0));
  }

  /** Add a user message bubble */
  addUser(text: string): void {
    this.addChild(new UserMessageComponent(text));
  }

  /** Add a styled event log entry */
  addEvent(styledText: string): void {
    this.addChild(new Spacer(1));
    this.addChild(new Text(styledText, 1, 0));
  }

  private resolveRunId(runId?: string): string {
    return runId ?? "default";
  }

  /** Start a new assistant message (streaming) */
  startAssistant(text: string, runId?: string): AssistantMessageComponent {
    const component = new AssistantMessageComponent(text);
    this.streamingRuns.set(this.resolveRunId(runId), component);
    this.addChild(component);
    return component;
  }

  /** Update an existing streaming assistant message, or start one */
  updateAssistant(text: string, runId?: string): void {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) {
      this.startAssistant(text, runId);
      return;
    }
    existing.setText(text);
  }

  /** Finalize an assistant message (streaming complete) */
  finalizeAssistant(text: string, runId?: string): void {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (existing) {
      existing.setText(text);
      this.streamingRuns.delete(effectiveRunId);
      return;
    }
    this.addChild(new AssistantMessageComponent(text));
  }

  /** Drop an assistant message (empty response) */
  dropAssistant(runId?: string): void {
    const effectiveRunId = this.resolveRunId(runId);
    const existing = this.streamingRuns.get(effectiveRunId);
    if (!existing) return;
    this.removeChild(existing);
    this.streamingRuns.delete(effectiveRunId);
  }

  /** Start a tool execution card */
  startTool(toolCallId: string, toolName: string, args: unknown): ToolExecutionComponent {
    const existing = this.toolById.get(toolCallId);
    if (existing) {
      existing.setArgs(args);
      return existing;
    }
    const component = new ToolExecutionComponent(toolName, args);
    component.setExpanded(this.toolsExpanded);
    this.toolById.set(toolCallId, component);
    this.addChild(component);
    return component;
  }

  /** Update tool result */
  updateToolResult(
    toolCallId: string,
    result: unknown,
    opts?: { isError?: boolean; partial?: boolean },
  ): void {
    const existing = this.toolById.get(toolCallId);
    if (!existing) return;
    if (opts?.partial) {
      existing.setPartialResult(result);
      return;
    }
    existing.setResult(result, { isError: opts?.isError });
  }

  /** Toggle tool output expansion */
  setToolsExpanded(expanded: boolean): void {
    this.toolsExpanded = expanded;
    for (const tool of this.toolById.values()) {
      tool.setExpanded(expanded);
    }
  }
}
