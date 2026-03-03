"use client";

// Barrel re-export — keeps backward-compatible import path:
//   import { ... } from "@/components/ai-elements/prompt-input"
//
// The implementation is split into:
//   prompt-input-provider.tsx  — contexts, hooks, PromptInputProvider
//   prompt-input-core.tsx      — PromptInput, PromptInputTextarea, PromptInputSubmit, action menu
//   prompt-input-parts.tsx     — thin UI wrapper components (layout, select, hovercard, tabs, command)

export {
  // Contexts & hooks
  usePromptInputController,
  useProviderAttachments,
  usePromptInputAttachments,
  usePromptInputReferencedSources,
  LocalReferencedSourcesContext,
  // Provider
  PromptInputProvider,
} from "./prompt-input-provider";

export type {
  AttachmentsContext,
  TextInputContext,
  PromptInputControllerProps,
  ReferencedSourcesContext,
  PromptInputProviderProps,
} from "./prompt-input-provider";

export {
  // Core components
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputButton,
  PromptInputActionAddAttachments,
  // Action menu
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
} from "./prompt-input-core";

export type {
  PromptInputMessage,
  PromptInputProps,
  PromptInputTextareaProps,
  PromptInputSubmitProps,
  PromptInputButtonTooltip,
  PromptInputButtonProps,
  PromptInputActionAddAttachmentsProps,
  PromptInputActionMenuProps,
  PromptInputActionMenuTriggerProps,
  PromptInputActionMenuContentProps,
  PromptInputActionMenuItemProps,
} from "./prompt-input-core";

export {
  // Layout
  PromptInputBody,
  PromptInputHeader,
  PromptInputFooter,
  PromptInputTools,
  // Select
  PromptInputSelect,
  PromptInputSelectTrigger,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectValue,
  // HoverCard
  PromptInputHoverCard,
  PromptInputHoverCardTrigger,
  PromptInputHoverCardContent,
  // Tabs
  PromptInputTabsList,
  PromptInputTab,
  PromptInputTabLabel,
  PromptInputTabBody,
  PromptInputTabItem,
  // Command
  PromptInputCommand,
  PromptInputCommandInput,
  PromptInputCommandList,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandSeparator,
} from "./prompt-input-parts";

export type {
  PromptInputBodyProps,
  PromptInputHeaderProps,
  PromptInputFooterProps,
  PromptInputToolsProps,
  PromptInputSelectProps,
  PromptInputSelectTriggerProps,
  PromptInputSelectContentProps,
  PromptInputSelectItemProps,
  PromptInputSelectValueProps,
  PromptInputHoverCardProps,
  PromptInputHoverCardTriggerProps,
  PromptInputHoverCardContentProps,
  PromptInputTabsListProps,
  PromptInputTabProps,
  PromptInputTabLabelProps,
  PromptInputTabBodyProps,
  PromptInputTabItemProps,
  PromptInputCommandProps,
  PromptInputCommandInputProps,
  PromptInputCommandListProps,
  PromptInputCommandEmptyProps,
  PromptInputCommandGroupProps,
  PromptInputCommandItemProps,
  PromptInputCommandSeparatorProps,
} from "./prompt-input-parts";
