/**
 * Turn a non-streaming completion choice into a channel reply.
 *
 * Agents end some turns with client-side UI actions meant for the web chat
 * (open_file, open_tab, ask_user, previews…). Channels cannot render them, so
 * they are translated: files become documents to send, links become text, and
 * anything that needs the web UI says so instead of producing an empty reply.
 */

import { basename } from "node:path";
import type { ChannelOutboundFile } from "../notifications/channel-gateway.js";
import { resolveSharedFile } from "../core/shared-files.js";

export { resolveSharedFile };

export interface ChannelChatResult { text: string; files: ChannelOutboundFile[] }

const WEB_ONLY: Record<string, string> = {
  widget_render: "I prepared an interactive view: open the web chat to see it.",
  mission_preview: "I prepared a mission to review: confirm it in the web chat.",
  vault_preview: "A credential change needs your confirmation in the web chat.",
  email_preview: "An email is ready to review: confirm it in the web chat.",
  whatsapp_preview: "A WhatsApp message is ready to review: confirm it in the web chat.",
  set_design: "Open the web chat to see the new design.",
};

export function interpretChannelCompletion(choice: any, roots: string[]): ChannelChatResult {
  const notes: string[] = [];
  const files: ChannelOutboundFile[] = [];
  let text: string = choice?.message?.content ?? "";

  // ask_user: render the questions as text and let the user answer in their next message.
  const questions: any[] = choice?.ask_user?.questions ?? [];
  if (questions.length > 0) {
    const asked = questions.map((q) => {
      const options = (q?.options ?? []).map((o: any, i: number) => `  ${i + 1}. ${o?.label ?? o}`).join("\n");
      return [`• ${q?.question ?? q?.header ?? ""}`, options].filter(Boolean).join("\n");
    }).join("\n\n");
    notes.push(asked, "Reply with your answer.");
  }

  switch (choice?.finish_reason) {
    case "open_file": {
      const requested: string | undefined = choice.open_file?.path;
      const path = requested ? resolveSharedFile(requested, roots) : undefined;
      if (path) files.push({ path, filename: basename(path) });
      else if (requested) notes.push(`(Could not attach ${basename(requested)}: file not found.)`);
      break;
    }
    case "open_tab": {
      const { url, label } = choice.open_tab ?? {};
      if (url) notes.push(`🔗 [${label || url}](${url})`);
      break;
    }
    case "navigate_to": {
      const target = choice.navigate_to?.target;
      if (target) notes.push(`(Open the web app → ${target} to see it.)`);
      break;
    }
    default: {
      const webOnly = WEB_ONLY[choice?.finish_reason];
      if (webOnly) notes.push(webOnly);
    }
  }

  text = [text.trim(), ...notes].filter(Boolean).join("\n\n");
  return { text, files };
}
