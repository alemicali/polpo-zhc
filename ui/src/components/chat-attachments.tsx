import { useEffect, useState } from "react";
import { config } from "@/lib/config";
import type { ChatMessage } from "@polpo-ai/react";

type Attachment = NonNullable<ChatMessage["attachments"]>[number] & { previewUrl?: string };
export function ChatAttachments({ attachments }: { attachments?: Attachment[] }) {
  return attachments?.length ? <div className="flex flex-wrap gap-3 mb-2">{attachments.map(a => <AttachmentCard key={a.id} attachment={a} />)}</div> : null;
}
function AttachmentCard({ attachment: a }: { attachment: Attachment }) {
  const [url, setUrl] = useState(a.previewUrl || "");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (a.previewUrl) { setUrl(a.previewUrl); return; }
    const ac = new AbortController();
    let objectUrl = "";
    setUrl(""); setError(false);
    void fetch(`${config.baseUrl || ""}/api/v1/attachments/${encodeURIComponent(a.id)}/download`, {
      headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}, signal: ac.signal, credentials: "include",
    }).then(async r => {
      if (!r.ok) throw new Error("Attachment unavailable");
      const blob = await r.blob();
      if (ac.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (!ac.signal.aborted) setError(true); });
    return () => { ac.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [a.id, a.previewUrl, retry]);
  return <div className="overflow-hidden rounded-xl border border-current/20 min-w-36 max-w-72 p-2">
    {error ? <button type="button" className="text-sm underline min-h-11" onClick={() => setRetry(n => n + 1)}>Attachment unavailable · Retry</button>
      : !url ? <div className="text-xs py-4" role="status">Loading attachment…</div>
      : <>
        {a.mimeType.startsWith("image/") && <a href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${a.filename}`}>
          <img src={url} alt={a.filename} onError={() => setError(true)} className="max-h-64 w-full rounded-lg object-contain" loading="lazy" />
        </a>}
        <a href={url} download={a.filename} className="block text-xs underline py-2 break-all">{a.filename}</a>
      </>}
    <div className="text-[10px] opacity-80">{a.previewUrl ? "Pending server confirmation" : "Saved to conversation"}</div>
  </div>;
}
