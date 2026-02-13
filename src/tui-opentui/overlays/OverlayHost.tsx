import { useTUIStore } from "../../tui/store.js";
import { Picker } from "./Picker.js";
import { TextInputOverlay } from "./TextInput.js";
import { YamlEditor } from "./YamlEditor.js";
import { ContentViewer } from "./ContentViewer.js";

export function OverlayHost({ width, height }: { width: number; height: number }) {
  const activeOverlay = useTUIStore((s) => s.activeOverlay);
  const overlayProps = useTUIStore((s) => s.overlayProps);
  const closeOverlay = useTUIStore((s) => s.closeOverlay);

  if (!activeOverlay) return null;

  // Overlay dimensions by type
  let overlayW: number;
  let overlayH: number | undefined;

  switch (activeOverlay) {
    case "content-viewer":
    case "plan-preview":
    case "task-browser":
      overlayW = Math.max(40, width - 4);
      overlayH = Math.max(10, height - 2);
      break;
    case "yaml-editor":
      overlayW = Math.max(40, width - 4);
      overlayH = Math.max(10, height - 2);
      break;
    case "picker":
      overlayW = Math.min(Math.max(40, width - 4), 80);
      break;
    case "text-input":
      overlayW = Math.min(Math.max(30, width - 4), 60);
      break;
    default:
      overlayW = Math.max(40, width - 4);
  }

  const pickerMaxVisible = Math.max(5, height - 8);

  const renderOverlay = () => {
    const props = overlayProps;

    switch (activeOverlay) {
      case "picker":
        return (
          <Picker
            title={(props.title as string) ?? "Select"}
            items={(props.items as Array<{ label: string; value: string }>) ?? []}
            onSelect={(index, value) => {
              closeOverlay();
              const callback = props.onSelect as ((index: number, value: string) => void) | undefined;
              callback?.(index, value);
            }}
            onCancel={() => {
              closeOverlay();
              const callback = props.onCancel as (() => void) | undefined;
              callback?.();
            }}
            borderColor={props.borderColor as string}
            onKey={props.onKey ? (input: string, key: any, idx: number, val: string) => {
              const callback = props.onKey as ((input: string, key: any, idx: number, val: string) => void) | undefined;
              callback?.(input, key, idx, val);
            } : undefined}
            hint={props.hint as string}
            maxVisible={pickerMaxVisible}
          />
        );

      case "text-input":
        return (
          <TextInputOverlay
            title={(props.title as string) ?? "Input"}
            initial={props.initial as string}
            onSubmit={(value) => {
              closeOverlay();
              const callback = props.onSubmit as ((value: string) => void) | undefined;
              callback?.(value);
            }}
            onCancel={() => {
              closeOverlay();
              const callback = props.onCancel as (() => void) | undefined;
              callback?.();
            }}
          />
        );

      case "yaml-editor":
        return (
          <YamlEditor
            title={(props.title as string) ?? "Editor"}
            initial={props.initial as string}
            onSave={(value) => {
              closeOverlay();
              const callback = props.onSave as ((value: string) => void) | undefined;
              callback?.(value);
            }}
            onCancel={() => {
              closeOverlay();
              const callback = props.onCancel as (() => void) | undefined;
              callback?.();
            }}
          />
        );

      case "content-viewer":
      case "plan-preview":
      case "task-browser":
        return (
          <ContentViewer
            title={(props.title as string) ?? "View"}
            content={(props.content as string) ?? ""}
            actions={props.actions as string[]}
            onAction={(index) => {
              const callback = props.onAction as ((index: number) => void) | undefined;
              callback?.(index);
            }}
            onClose={() => {
              closeOverlay();
              const callback = props.onClose as (() => void) | undefined;
              callback?.();
            }}
            onTab={props.onTab as (() => string | null)}
            height={overlayH}
          />
        );

      default:
        return null;
    }
  };

  return (
    <box
      style={{
        flexDirection: "column",
        width,
        height,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <box style={{ width: overlayW, height: overlayH }}>
        {renderOverlay()}
      </box>
    </box>
  );
}
