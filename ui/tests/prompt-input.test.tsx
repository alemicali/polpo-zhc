import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PromptInput, PromptInputTextarea, type PromptInputProps } from "../src/components/ai-elements/prompt-input-core";
import { PromptInputProvider } from "../src/components/ai-elements/prompt-input-provider";
import { usePromptInputAttachments } from "../src/components/ai-elements/prompt-input-context";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const textarea = () => container.querySelector("textarea")!;
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
}
async function render(onSubmit: PromptInputProps["onSubmit"], key = "a", provider = false) {
  await act(async () => {
    const input = <PromptInput onSubmit={onSubmit} submissionKey={key}><PromptInputTextarea /></PromptInput>;
    root.render(provider ? <PromptInputProvider>{input}</PromptInputProvider> : input);
  });
}
function pendingSend() {
  let accept!: () => void;
  let finish!: () => void;
  let fail!: (reason: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  const send = vi.fn<PromptInputProps["onSubmit"]>((_message, _event, acknowledge) => { accept = acknowledge; return promise; });
  return { send, accept: () => accept(), finish: () => finish(), fail: () => fail(new Error("failed")) };
}

test.each([false, true])("acknowledgement clears before stream ends, preserves next draft (provider=%s)", async provider => {
  const stream = pendingSend();
  await render(stream.send, "a", provider);
  await type("sent prompt"); await submit();
  expect(textarea().value).toBe("sent prompt");
  await act(async () => stream.accept());
  expect(textarea().value).toBe("");
  await type("next draft");
  await act(async () => stream.finish());
  expect(textarea().value).toBe("next draft");
});
test.each([false, true])("editing while request is pending survives acknowledgement (provider=%s)", async provider => {
  const stream = pendingSend(); await render(stream.send, "a", provider);
  await type("first"); await submit(); await type("edited");
  await act(async () => { stream.accept(); stream.finish(); });
  expect(textarea().value).toBe("edited");
});
test("failed sends preserve the prompt and allow retry", async () => {
  const stream = pendingSend(); await render(stream.send);
  await type("keep this"); await submit();
  await act(async () => stream.fail());
  expect(textarea().value).toBe("keep this");
  const retry = pendingSend(); await render(retry.send); await submit();
  expect(retry.send).toHaveBeenCalledOnce();
  await act(async () => { retry.accept(); retry.finish(); });
  expect(textarea().value).toBe("");
});
test("double submit before acknowledgement starts one request", async () => {
  const stream = pendingSend(); await render(stream.send);
  await type("once"); await submit(); await submit();
  expect(stream.send).toHaveBeenCalledOnce();
  await act(async () => stream.finish());
});
test("late acknowledgement cannot erase another chat's identical text", async () => {
  const stream = pendingSend(); await render(stream.send);
  await type("same text"); await submit();
  await render(stream.send, "other-chat");
  await act(async () => { stream.accept(); stream.finish(); });
  expect(textarea().value).toBe("same text");
});
test("completion after acknowledgement does not clear a new identical draft", async () => {
  const stream = pendingSend(); await render(stream.send);
  await type("same"); await submit();
  await act(async () => stream.accept()); await type("same");
  await act(async () => stream.finish());
  expect(textarea().value).toBe("same");
});
test("legacy synchronous submit still clears and emits input", async () => {
  await render(() => {}); await type("send");
  const onInput = vi.fn(); textarea().addEventListener("input", onInput);
  await submit();
  expect(textarea().value).toBe(""); expect(onInput).toHaveBeenCalledOnce();
});

function AttachmentNames() {
  const { files } = usePromptInputAttachments();
  return <output>{files.map(file => file.filename).join(",")}</output>;
}
async function attachmentForm(send: PromptInputProps["onSubmit"]) {
  let id = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL() { return "blob:qa-" + ++id; }
    static revokeObjectURL() {}
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob(["hello"], { type: "text/plain" }) })));
  await act(async () => root.render(<PromptInput onSubmit={send}><PromptInputTextarea /><AttachmentNames /></PromptInput>));
}
async function attach(name: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["hello"], name, { type: "text/plain" })] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
test("acknowledgement removes only submitted attachments, not newly added ones", async () => {
  const stream = pendingSend(); await attachmentForm(stream.send);
  await attach("sent.txt"); await submit();
  await vi.waitFor(() => expect(stream.send).toHaveBeenCalledOnce());
  expect(stream.send.mock.calls[0][0].files[0].url).toMatch(/^data:text\/plain;base64,/);
  await attach("next.txt");
  await act(async () => stream.accept());
  expect(container.querySelector("output")!.textContent).toBe("next.txt");
  await act(async () => stream.finish());
  expect(container.querySelector("output")!.textContent).toBe("next.txt");
});
test("rejected upload keeps its file and prompt", async () => {
  const stream = pendingSend(); await attachmentForm(stream.send);
  await attach("retry.txt"); await type("retry me"); await submit();
  await vi.waitFor(() => expect(stream.send).toHaveBeenCalledOnce());
  await act(async () => stream.fail());
  expect(textarea().value).toBe("retry me");
  expect(container.querySelector("output")!.textContent).toBe("retry.txt");
});
test("unreadable attachment prevents send and remains available", async () => {
  const stream = pendingSend(); await attachmentForm(stream.send);
  vi.mocked(fetch).mockRejectedValue(new Error("unreadable"));
  await attach("unreadable.txt"); await type("keep me"); await submit();
  expect(stream.send).not.toHaveBeenCalled();
  expect(textarea().value).toBe("keep me");
  expect(container.querySelector("output")!.textContent).toBe("unreadable.txt");
});
