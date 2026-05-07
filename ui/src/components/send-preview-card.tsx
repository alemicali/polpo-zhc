/**
 * Approval-gate cards for side-effect tools — `whatsapp_send`,
 * `whatsapp_send_file` (rendered by WhatsAppPreviewCard) and
 * `email_send` (rendered by EmailPreviewCard).
 *
 * Same trust contract as `MissionPreviewCard`: server intercepts the
 * tool call, emits a preview chunk, the LLM turn ends. The user reads
 * the proposal here, then picks Send → REST API; Refine → feedback
 * back to LLM; Cancel → inform LLM the user declined. Nothing actually
 * goes out to the recipient until the user clicks Send.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { MessageCircle, Send, RefreshCw, Ban, Mail, Paperclip, FileText, Image as ImageIcon, Video, Music, File as FileIcon } from "lucide-react";
import type { WhatsAppPreviewData, EmailPreviewData, SendPreviewAction } from "@/hooks/use-polpo";
import { toast } from "sonner";

function joinRecipients(value: string | string[] | undefined): string {
  if (!value) return "";
  return Array.isArray(value) ? value.join(", ") : value;
}

function mediaIcon(kind: string | undefined): JSX.Element {
  switch (kind) {
    case "image": return <ImageIcon className="h-3.5 w-3.5" />;
    case "video": return <Video className="h-3.5 w-3.5" />;
    case "audio": return <Music className="h-3.5 w-3.5" />;
    case "document": return <FileText className="h-3.5 w-3.5" />;
    default: return <FileIcon className="h-3.5 w-3.5" />;
  }
}

function formatJid(to: string): string {
  // 39349XXXXXXX@s.whatsapp.net → +39 349 XXX XXXX (best effort).
  // We DON'T rely on regex lookbehind anywhere — only simple split.
  const at = to.indexOf("@");
  const num = at > 0 ? to.slice(0, at) : to;
  if (!/^\d+$/.test(num)) return to;
  // Group as +XX YYY YYY YYYY for readability — naive but harmless.
  if (num.length <= 6) return `+${num}`;
  return `+${num.slice(0, 2)} ${num.slice(2)}`;
}

export function WhatsAppPreviewCard({
  preview,
  onRespond,
  disabled,
}: {
  preview: WhatsAppPreviewData;
  onRespond: (action: SendPreviewAction, feedback?: string) => Promise<{ id?: string; error?: string }>;
  disabled?: boolean;
}) {
  const [refineMode, setRefineMode] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isFile = preview.kind === "file";
  const recipientLabel = preview.to.includes("@") ? formatJid(preview.to) : preview.to;

  const handle = async (action: SendPreviewAction, fb?: string) => {
    setSubmitting(true);
    try {
      const result = await onRespond(action, fb);
      if (result.error) {
        toast.error("WhatsApp send failed", { description: result.error });
      } else if (action === "send") {
        toast.success("WhatsApp message sent", { description: `to ${recipientLabel}` });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mobile-no-x mt-3 overflow-hidden rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-emerald-500/10 bg-emerald-500/[0.02] px-3 py-2 sm:px-4 sm:py-3">
        <MessageCircle className="h-4 w-4 shrink-0 text-emerald-600" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">WhatsApp to {recipientLabel}</p>
          <p className="text-[11px] text-muted-foreground">
            {isFile ? `Attachment · ${preview.fileName ?? preview.path}` : "Text message"}
          </p>
        </div>
        <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex border-emerald-500/30 text-emerald-700">
          Awaiting confirmation
        </Badge>
      </div>

      {/* Body */}
      <div className="px-3 py-3 sm:px-4 sm:py-4 space-y-3">
        {/* Recipient pill */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">To</span>
          <code className="rounded bg-background/60 px-1.5 py-0.5 text-xs font-mono">{recipientLabel}</code>
        </div>

        {/* Text body */}
        {!isFile && (
          <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2 max-h-48 overflow-y-auto">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{preview.message}</p>
          </div>
        )}

        {/* File payload */}
        {isFile && (
          <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
              <code className="font-mono">{preview.path}</code>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant="secondary" className="gap-1 text-[10px]">
                {mediaIcon(preview.mediaKind)}
                {preview.mediaKind ?? "auto"}
              </Badge>
              {preview.mimeType && (
                <Badge variant="secondary" className="text-[10px]">{preview.mimeType}</Badge>
              )}
              {preview.fileName && preview.fileName !== preview.path && (
                <Badge variant="secondary" className="text-[10px]">as {preview.fileName}</Badge>
              )}
              {preview.viewOnce && (
                <Badge variant="secondary" className="text-[10px]">view-once</Badge>
              )}
            </div>
            {preview.caption && (
              <p className="whitespace-pre-wrap pt-1 text-sm leading-relaxed">{preview.caption}</p>
            )}
          </div>
        )}
      </div>

      {/* Refine input */}
      {refineMode && (
        <div className="border-t border-emerald-500/10 px-3 pb-3 sm:px-4">
          <p className="text-xs text-muted-foreground mt-2 mb-1.5">What would you like to change?</p>
          <Textarea
            placeholder="e.g., Make it more concise, change the recipient..."
            className="min-h-[60px] bg-background/60 text-base sm:text-sm"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={disabled || submitting}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setRefineMode(false); setFeedback(""); }} disabled={submitting}>
              Back
            </Button>
            <Button size="sm" disabled={!feedback.trim() || disabled || submitting} onClick={() => handle("refine", feedback.trim())} className="gap-1.5">
              <Send className="h-3.5 w-3.5" />
              Send feedback
            </Button>
          </div>
        </div>
      )}

      {/* Actions */}
      {!refineMode && (
        <div className="grid grid-cols-2 gap-2 border-t border-emerald-500/10 bg-emerald-500/[0.02] px-3 py-2.5 sm:flex sm:items-center sm:px-4 sm:py-3">
          <Button variant="ghost" size="sm" disabled={disabled || submitting} onClick={() => handle("cancel")}
            className="w-full gap-1.5 text-muted-foreground hover:text-destructive sm:w-auto">
            <Ban className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <div className="hidden flex-1 sm:block" />
          <Button variant="outline" size="sm" disabled={disabled || submitting} onClick={() => setRefineMode(true)}
            className="w-full gap-1.5 sm:w-auto">
            <RefreshCw className="h-3.5 w-3.5" />
            Refine
          </Button>
          <Button size="sm" disabled={disabled || submitting} onClick={() => handle("send")}
            className="w-full gap-1.5 bg-emerald-600 hover:bg-emerald-700 sm:w-auto">
            {submitting ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send
          </Button>
        </div>
      )}
    </div>
  );
}

export function EmailPreviewCard({
  preview,
  onRespond,
  disabled,
}: {
  preview: EmailPreviewData;
  onRespond: (action: SendPreviewAction, feedback?: string) => Promise<{ id?: string; error?: string }>;
  disabled?: boolean;
}) {
  const [refineMode, setRefineMode] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const toLabel = joinRecipients(preview.to);
  const ccLabel = joinRecipients(preview.cc);
  const bccLabel = joinRecipients(preview.bcc);

  const handle = async (action: SendPreviewAction, fb?: string) => {
    setSubmitting(true);
    try {
      const result = await onRespond(action, fb);
      if (result.error) {
        toast.error("Email send failed", { description: result.error });
      } else if (action === "send") {
        toast.success("Email sent", { description: `to ${toLabel}` });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mobile-no-x mt-3 overflow-hidden rounded-xl border border-sky-500/20 bg-sky-500/[0.03]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-sky-500/10 bg-sky-500/[0.02] px-3 py-2 sm:px-4 sm:py-3">
        <Mail className="h-4 w-4 shrink-0 text-sky-600" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{preview.subject || "(no subject)"}</p>
          <p className="text-[11px] text-muted-foreground truncate">to {toLabel}</p>
        </div>
        <Badge variant="outline" className="hidden shrink-0 text-[10px] sm:inline-flex border-sky-500/30 text-sky-700">
          Awaiting confirmation
        </Badge>
      </div>

      {/* Header pills */}
      <div className="px-3 py-3 sm:px-4 space-y-1.5 border-b border-sky-500/10">
        <div className="flex flex-wrap items-baseline gap-2 text-xs">
          <span className="w-12 text-right text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">To</span>
          <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono break-all">{toLabel}</code>
        </div>
        {ccLabel && (
          <div className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="w-12 text-right text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">Cc</span>
            <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono break-all">{ccLabel}</code>
          </div>
        )}
        {bccLabel && (
          <div className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="w-12 text-right text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">Bcc</span>
            <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono break-all">{bccLabel}</code>
          </div>
        )}
        {preview.from && (
          <div className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="w-12 text-right text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">From</span>
            <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono break-all">{preview.from}</code>
          </div>
        )}
        {preview.reply_to && (
          <div className="flex flex-wrap items-baseline gap-2 text-xs">
            <span className="w-12 text-right text-[11px] uppercase tracking-wide text-muted-foreground shrink-0">Reply</span>
            <code className="rounded bg-background/60 px-1.5 py-0.5 font-mono break-all">{preview.reply_to}</code>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-3 sm:px-4 sm:py-4">
        <div className="rounded-lg border border-border/60 bg-background/50 px-3 py-2 max-h-72 overflow-y-auto">
          {preview.html ? (
            // We deliberately render the HTML body as escaped text in the
            // preview — the iframe-sandbox path is only for render_widget.
            // Showing the raw markup keeps the user aware of what's about
            // to be SMTP-shipped.
            <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed font-mono">{preview.body}</pre>
          ) : (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{preview.body}</p>
          )}
        </div>
        {preview.attachments && preview.attachments.length > 0 && (
          <div className="mt-3 space-y-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Attachments</p>
            <ul className="space-y-1">
              {preview.attachments.map((att, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                  <code className="font-mono">{att.filename ?? att.path}</code>
                  {att.filename && att.filename !== att.path && (
                    <span className="text-[11px] text-muted-foreground">({att.path})</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Refine */}
      {refineMode && (
        <div className="border-t border-sky-500/10 px-3 pb-3 sm:px-4">
          <p className="text-xs text-muted-foreground mt-2 mb-1.5">What would you like to change?</p>
          <Textarea
            placeholder="e.g., Make the tone more formal, add a sign-off..."
            className="min-h-[60px] bg-background/60 text-base sm:text-sm"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={disabled || submitting}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setRefineMode(false); setFeedback(""); }} disabled={submitting}>
              Back
            </Button>
            <Button size="sm" disabled={!feedback.trim() || disabled || submitting} onClick={() => handle("refine", feedback.trim())} className="gap-1.5">
              <Send className="h-3.5 w-3.5" />
              Send feedback
            </Button>
          </div>
        </div>
      )}

      {/* Actions */}
      {!refineMode && (
        <div className="grid grid-cols-2 gap-2 border-t border-sky-500/10 bg-sky-500/[0.02] px-3 py-2.5 sm:flex sm:items-center sm:px-4 sm:py-3">
          <Button variant="ghost" size="sm" disabled={disabled || submitting} onClick={() => handle("cancel")}
            className="w-full gap-1.5 text-muted-foreground hover:text-destructive sm:w-auto">
            <Ban className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <div className="hidden flex-1 sm:block" />
          <Button variant="outline" size="sm" disabled={disabled || submitting} onClick={() => setRefineMode(true)}
            className="w-full gap-1.5 sm:w-auto">
            <RefreshCw className="h-3.5 w-3.5" />
            Refine
          </Button>
          <Button size="sm" disabled={disabled || submitting} onClick={() => handle("send")}
            className="w-full gap-1.5 bg-sky-600 hover:bg-sky-700 sm:w-auto">
            {submitting ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Send
          </Button>
        </div>
      )}
    </div>
  );
}
