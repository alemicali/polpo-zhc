/**
 * AgentCredentialsTab — vault entries assigned to this specific agent.
 * Shows service credentials (SMTP, API keys, logins, etc.) stored in the
 * encrypted vault. Provider-level OAuth profiles live in Configuration.
 */

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  KeyRound,
  Lock,
  Mail,
  Inbox,
  Fingerprint,
  Key,
  LogIn,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/shared/section-header";
import { useAgentDetail } from "./agent-detail-provider";
import type { VaultEntryMeta } from "@lumea-technologies/polpo-react";

// ── Type metadata ──

type VaultType = VaultEntryMeta["type"];

const TYPE_META: Record<VaultType, { label: string; description: string; icon: typeof Mail; color: string }> = {
  smtp:    { label: "SMTP",    description: "Outgoing email",     icon: Mail,        color: "text-blue-500 bg-blue-500/10 border-blue-500/20" },
  imap:    { label: "IMAP",    description: "Incoming email",     icon: Inbox,       color: "text-indigo-500 bg-indigo-500/10 border-indigo-500/20" },
  oauth:   { label: "OAuth",   description: "OAuth credentials",  icon: Fingerprint, color: "text-violet-500 bg-violet-500/10 border-violet-500/20" },
  api_key: { label: "API Key", description: "API authentication", icon: Key,         color: "text-amber-500 bg-amber-500/10 border-amber-500/20" },
  login:   { label: "Login",   description: "Username & password", icon: LogIn,      color: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20" },
  custom:  { label: "Custom",  description: "Custom credentials", icon: Settings2,   color: "text-gray-400 bg-gray-400/10 border-gray-400/20" },
};

// ── Vault Entry Card ──

function VaultEntryCard({ entry }: { entry: VaultEntryMeta }) {
  const meta = TYPE_META[entry.type] ?? TYPE_META.custom;
  const TypeIcon = meta.icon;

  return (
    <div className="rounded-lg border border-border/30 bg-card/60 px-4 py-3 space-y-2.5">
      <div className="flex items-center gap-2.5">
        <div className={cn("flex items-center justify-center h-7 w-7 rounded-md border shrink-0", meta.color)}>
          <TypeIcon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{entry.service}</span>
          {entry.label && (
            <p className="text-[11px] text-muted-foreground truncate">{entry.label}</p>
          )}
        </div>
        <Badge variant="outline" className={cn("text-[10px] shrink-0 gap-1 border", meta.color)}>
          {meta.label}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-1.5 ml-9.5">
        {entry.keys.map((k: string) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded bg-muted/50 border border-border/30 px-2 py-0.5 text-[11px] font-mono text-muted-foreground"
          >
            {k}: <span className="text-[10px] opacity-60">***</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Empty state type pill ──

function TypePill({ type }: { type: VaultType }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-lg border px-3 py-2",
      meta.color,
    )}>
      <Icon className="h-3.5 w-3.5" />
      <div className="text-left">
        <p className="text-[11px] font-medium leading-none">{meta.label}</p>
        <p className="text-[10px] opacity-60 mt-0.5">{meta.description}</p>
      </div>
    </div>
  );
}

// ── Main Tab ──

export function AgentCredentialsTab() {
  const { state: { vaultEntries } } = useAgentDetail();

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">
        <div>
          <SectionHeader title="Credential Vault" icon={KeyRound} count={vaultEntries.length || undefined} />
          {vaultEntries.length > 0 ? (
            <div className="space-y-2">
              {vaultEntries.map((entry: VaultEntryMeta) => (
                <VaultEntryCard key={entry.service} entry={entry} />
              ))}
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                Encrypted with AES-256-GCM in <code className="font-mono">.polpo/vault.enc</code>. Use the chat to manage entries.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground max-w-sm mx-auto text-center">
              <Lock className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium">No vault entries</p>
              <p className="text-xs text-muted-foreground/60 mt-2 leading-relaxed">
                Use the chat to add service credentials for this agent. Supported types:
              </p>
              <div className="grid grid-cols-2 gap-2 mt-4 w-full">
                {(["smtp", "imap", "api_key", "oauth", "login", "custom"] as VaultType[]).map(t => (
                  <TypePill key={t} type={t} />
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/40 mt-4">
                Entries are encrypted with AES-256-GCM in <code className="font-mono">.polpo/vault.enc</code>.
                Provider-level auth is managed in Configuration.
              </p>
            </div>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
