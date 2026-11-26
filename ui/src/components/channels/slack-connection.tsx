/**
 * A saved Slack channel's app: the Socket Mode connection (no public URL: the instance opens an
 * outbound WebSocket to Slack), the two tokens — stored in the vault, shown only as "Stored" /
 * "Not set", never again — and a test with the bot token. The setup guide is docs/slack.md.
 */
import { useState } from "react";
import { Loader2, PlugZap, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useSlackStatus, type SlackSecretKind, type SlackStatus } from "@polpo-ai/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { productName, useInstanceBranding } from "@/lib/branding";
import { notifySetupSaved } from "@/lib/setup-link";
import { cn } from "@/lib/utils";

const STATE: Record<SlackStatus["state"], { label: string; className: string }> = {
  connected: { label: "Connected", className: "border-success/30 bg-success/10 text-success" },
  reconnecting: { label: "Reconnecting", className: "border-warning/30 bg-warning/10 text-warning" },
  connecting: { label: "Connecting", className: "border-info/30 bg-info/10 text-info" },
  stopped: { label: "Not connected", className: "border-border bg-muted/40 text-muted-foreground" },
  "not-configured": { label: "Not configured", className: "border-border bg-muted/40 text-muted-foreground" },
  error: { label: "Error", className: "border-destructive/30 bg-destructive/10 text-destructive" },
};

const TOKENS: Array<{ kind: SlackSecretKind; label: string; hint: string; placeholder: string }> = [
  { kind: "botToken", label: "Bot token", hint: "Slack app → OAuth & Permissions → Bot User OAuth Token. Reads files, posts replies, uploads files.", placeholder: "xoxb-…" },
  { kind: "appToken", label: "App-level token", hint: "Slack app → Basic Information → App-Level Tokens, with the connections:write scope. Opens the Socket Mode connection.", placeholder: "xapp-…" },
];

function TokenRow({ spec, stored, onSave, onRemove }: {
  spec: (typeof TOKENS)[number];
  stored: boolean;
  onSave: (value: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      notifySetupSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1.5" data-testid={`slack-secret-${spec.kind}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{spec.label}</span>
        <Badge variant="outline" className={cn("font-normal", stored ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning")}>
          {stored ? "Stored" : "Not set"}
        </Badge>
        {stored && (
          <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={`Remove the ${spec.label.toLowerCase()}`} disabled={busy}
            onClick={() => void run(onRemove, `${spec.label} removed`)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Input type="password" autoComplete="off" data-setup-field={spec.kind} className="h-8 text-xs font-mono"
          placeholder={stored ? "Stored: paste a new one to replace it" : spec.placeholder}
          value={value} onChange={(e) => setValue(e.target.value)} aria-label={spec.label} />
        <Button size="sm" className="h-8 text-xs" disabled={busy || !value.trim()}
          onClick={() => void run(() => onSave(value.trim()), `${spec.label} saved`).then(() => setValue(""))}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      </div>
      <p className="text-micro leading-tight text-muted-foreground">{spec.hint}</p>
    </div>
  );
}

/** The Slack app of a saved channel: connection, tokens, test. */
export function SlackConnection({ channel }: { channel: string }) {
  const product = productName(useInstanceBranding());
  const { status, isLoading, error, setSecrets, removeSecret, test } = useSlackStatus(channel);
  const [testing, setTesting] = useState(false);
  if (isLoading && !status) return <div className="flex items-center gap-2 text-caption text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the Slack app…</div>;
  if (!status) return <p className="text-caption text-destructive">{error?.message ?? "Save the channel to connect its Slack app."}</p>;
  const state = STATE[status.state];
  const runTest = async () => {
    setTesting(true);
    try {
      const ok = await test();
      if (ok) toast.success("Slack accepts the bot token"); else toast.error("Slack refused the bot token");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="slack-connection" data-setup-item={channel}>
      <div className="flex flex-wrap items-center gap-2">
        <PlugZap className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Socket Mode</span>
        <Badge variant="outline" className={cn("font-normal", state.className)} data-testid="slack-state">{state.label}</Badge>
        {status.botName && <Badge variant="outline" className="font-normal">@{status.botName}{status.team ? ` · ${status.team}` : ""}</Badge>}
        <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" disabled={testing || !status.secrets.botToken} onClick={() => void runTest()}>
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Test"}
        </Button>
      </div>
      {!status.inbound && (
        <p className="text-caption text-muted-foreground">Inbound is off: with the bot token alone notifications are posted to the channel ID above. Turn inbound on under Routing to talk to {product} from Slack.</p>
      )}
      <div className="space-y-3">
        {TOKENS.map((spec) => (
          <TokenRow key={spec.kind} spec={spec} stored={status.secrets[spec.kind]}
            onSave={(value) => setSecrets({ [spec.kind]: value })} onRemove={() => removeSecret(spec.kind)} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
        <span>messages {status.received}</span>
        {status.connectedAt && <span>connected {new Date(status.connectedAt).toLocaleString()}</span>}
        {status.lastEventAt && <span>last event {new Date(status.lastEventAt).toLocaleString()}</span>}
      </div>
      {status.lastError && <p className="text-caption text-destructive">Last problem: {status.lastError}</p>}
    </div>
  );
}
