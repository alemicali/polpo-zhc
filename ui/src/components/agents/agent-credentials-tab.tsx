/**
 * AgentCredentialsTab — vault entries assigned to this specific agent.
 * Shows service credentials (SMTP, API keys, logins, etc.) stored in the
 * encrypted vault. Provider-level OAuth profiles live in Configuration.
 *
 * Allows adding / editing / deleting credential entries directly from the UI
 * (no chat interaction needed). All payloads are sent straight to the encrypted
 * vault via PolpoClient — values are never echoed back from the server.
 */

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  KeyRound,
  Lock,
  Mail,
  Inbox,
  Fingerprint,
  Key,
  LogIn,
  Settings2,
  Plus,
  Pencil,
  Trash2,
  ChevronLeft,
  Loader2,
  X,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionHeader } from "@/components/shared/section-header";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { useAgentDetail } from "./agent-detail-provider";
import { usePolpo, useAgents } from "@polpo-ai/react";
import type { VaultEntryMeta } from "@polpo-ai/react";
import { toast } from "sonner";

// ── Type metadata ──

type VaultType = VaultEntryMeta["type"];

const TYPE_META: Record<VaultType, {
  label: string;
  description: string;
  example: string;
  icon: typeof Mail;
  color: string;
}> = {
  smtp: {
    label: "SMTP",
    description: "Outgoing email server",
    example: "e.g. smtp.gmail.com — send notifications, reports",
    icon: Mail,
    color: "text-blue-500 bg-blue-500/10 border-blue-500/20",
  },
  imap: {
    label: "IMAP",
    description: "Incoming email server",
    example: "e.g. imap.gmail.com — read inbox, watch for replies",
    icon: Inbox,
    color: "text-indigo-500 bg-indigo-500/10 border-indigo-500/20",
  },
  oauth: {
    label: "OAuth",
    description: "OAuth tokens",
    example: "Access + refresh tokens for third-party APIs",
    icon: Fingerprint,
    color: "text-violet-500 bg-violet-500/10 border-violet-500/20",
  },
  api_key: {
    label: "API Key",
    description: "Single API key / token",
    example: "e.g. OpenAI key, Stripe secret, GitHub PAT",
    icon: Key,
    color: "text-amber-500 bg-amber-500/10 border-amber-500/20",
  },
  login: {
    label: "Login",
    description: "Username & password",
    example: "Web service login (with optional URL)",
    icon: LogIn,
    color: "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
  },
  custom: {
    label: "Custom",
    description: "Arbitrary key/value fields",
    example: "Anything that doesn't fit the other types",
    icon: Settings2,
    color: "text-gray-400 bg-gray-400/10 border-gray-400/20",
  },
};

const ALL_VAULT_TYPES: VaultType[] = ["smtp", "imap", "api_key", "oauth", "login", "custom"];

// ── Form state ──

interface CustomField {
  id: number;
  key: string;
  value: string;
}

interface FormState {
  service: string;
  label: string;
  type: VaultType;
  /** Logical mailbox account — groups SMTP+IMAP of the same mailbox.
   *  Empty string = "no account override" (resolver falls back to `service`). */
  account: string;
  /** Other agent names allowed to use this credential (shared). Owner
   *  always implicit. Empty array = owner-private. */
  allowedAgents: string[];
  // smtp / imap
  host: string;
  port: string;
  user: string;
  pass: string;
  secure: boolean;
  // oauth
  provider: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  // api_key
  keyName: string;
  keyValue: string;
  // login
  username: string;
  password: string;
  url: string;
  // custom
  customFields: CustomField[];
}

const SERVICE_RE = /^[a-zA-Z0-9_.-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function defaultForm(type: VaultType): FormState {
  return {
    service: "",
    label: "",
    type,
    account: "",
    allowedAgents: [],
    host: "",
    port: type === "smtp" ? "587" : type === "imap" ? "993" : "",
    user: "",
    pass: "",
    secure: type === "imap",
    provider: "",
    accessToken: "",
    refreshToken: "",
    expiresAt: "",
    keyName: "key",
    keyValue: "",
    username: "",
    password: "",
    url: "",
    customFields: [{ id: 1, key: "", value: "" }],
  };
}

// ── Validation ──

interface FormErrors {
  service?: string;
  port?: string;
  user?: string;
  username?: string;
  pass?: string;
  password?: string;
  accessToken?: string;
  keyName?: string;
  keyValue?: string;
  host?: string;
  provider?: string;
  customFields?: string;
}

function validateForm(form: FormState, isEdit: boolean): FormErrors {
  const errors: FormErrors = {};

  if (!isEdit) {
    if (!form.service.trim()) errors.service = "Service is required";
    else if (!SERVICE_RE.test(form.service.trim())) {
      errors.service = "Only letters, numbers, dots, dashes, underscores";
    }
  }

  switch (form.type) {
    case "smtp":
    case "imap": {
      if (!form.host.trim()) errors.host = "Host is required";
      const portN = Number(form.port);
      if (!form.port.trim() || !Number.isInteger(portN) || portN < 1 || portN > 65535) {
        errors.port = "Port must be an integer between 1 and 65535";
      }
      if (!form.user.trim()) errors.user = "User is required";
      else if (form.user.includes("@") && !EMAIL_RE.test(form.user.trim())) {
        errors.user = "Looks like an email but is not valid";
      }
      if (!form.pass) errors.pass = "Password is required";
      break;
    }
    case "oauth": {
      if (!form.provider.trim()) errors.provider = "Provider is required";
      if (!form.accessToken) errors.accessToken = "Access token is required";
      break;
    }
    case "api_key": {
      if (!form.keyName.trim()) errors.keyName = "Key name is required";
      if (!form.keyValue) errors.keyValue = "Key value is required";
      break;
    }
    case "login": {
      if (!form.username.trim()) errors.username = "Username is required";
      if (!form.password) errors.password = "Password is required";
      break;
    }
    case "custom": {
      const filled = form.customFields.filter((f) => f.key.trim());
      if (filled.length === 0) errors.customFields = "Add at least one field";
      else {
        const keys = new Set<string>();
        for (const f of filled) {
          if (!SERVICE_RE.test(f.key.trim())) {
            errors.customFields = `Invalid key "${f.key}" (use letters, numbers, dots, dashes, underscores)`;
            break;
          }
          if (keys.has(f.key.trim())) {
            errors.customFields = `Duplicate key "${f.key}"`;
            break;
          }
          keys.add(f.key.trim());
        }
      }
      break;
    }
  }
  return errors;
}

function buildCredentials(form: FormState): Record<string, string> {
  switch (form.type) {
    case "smtp":
    case "imap":
      return {
        host: form.host.trim(),
        port: String(Number(form.port)),
        user: form.user.trim(),
        pass: form.pass,
        secure: String(form.secure),
      };
    case "oauth": {
      const out: Record<string, string> = {
        provider: form.provider.trim(),
        accessToken: form.accessToken,
      };
      if (form.refreshToken) out.refreshToken = form.refreshToken;
      if (form.expiresAt) {
        const ts = new Date(form.expiresAt).getTime();
        if (!Number.isNaN(ts)) out.expiresAt = String(ts);
      }
      return out;
    }
    case "api_key":
      return { [form.keyName.trim()]: form.keyValue };
    case "login": {
      const out: Record<string, string> = {
        username: form.username.trim(),
        password: form.password,
      };
      if (form.url.trim()) out.url = form.url.trim();
      return out;
    }
    case "custom": {
      const out: Record<string, string> = {};
      for (const f of form.customFields) {
        const k = f.key.trim();
        if (k) out[k] = f.value;
      }
      return out;
    }
  }
}

// ── Small UI primitives ──

function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-foreground">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-[10px] text-destructive leading-tight">{error}</p>
      ) : hint ? (
        <p className="text-[10px] text-muted-foreground leading-tight">{hint}</p>
      ) : null}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "w-full flex items-center justify-between gap-3 rounded-md border border-border/50 bg-card/40 px-3 py-2 hover:border-primary/30 transition-colors text-left cursor-pointer",
      )}
    >
      <div className="min-w-0">
        <p className="text-xs font-medium">{label}</p>
        {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
      </div>
      <span
        className={cn(
          "inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          checked ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 rounded-full bg-background shadow transition-transform",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

// ── Vault Entry Card ──

function VaultEntryCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: VaultEntryMeta;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const meta = TYPE_META[entry.type] ?? TYPE_META.custom;
  const TypeIcon = meta.icon;

  return (
    <div className="rounded-lg border border-border/30 bg-card/60 px-4 py-3 space-y-2.5 group">
      <div className="flex items-center gap-2.5">
        <div className={cn("flex items-center justify-center h-7 w-7 rounded-md border shrink-0", meta.color)}>
          <TypeIcon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm font-medium">{entry.service}</span>
            {entry.account && (entry.type === "smtp" || entry.type === "imap") && (
              <Badge
                variant="outline"
                className="text-[9px] py-0 px-1.5 h-4 border-border/50 text-muted-foreground"
                title={`Mailbox account: ${entry.account}`}
              >
                @{entry.account}
              </Badge>
            )}
            {entry.sharedFrom && (
              <Badge
                variant="outline"
                className="text-[9px] py-0 px-1.5 h-4 border-amber-500/40 text-amber-500"
                title={`Inherited from agent "${entry.sharedFrom}". Edit there if you need to change it.`}
              >
                shared from {entry.sharedFrom}
              </Badge>
            )}
            {!entry.sharedFrom && entry.allowedAgents && entry.allowedAgents.length > 0 && (
              <Badge
                variant="outline"
                className="text-[9px] py-0 px-1.5 h-4 border-sky-500/40 text-sky-500"
                title={`Shared with: ${entry.allowedAgents.join(", ")}`}
              >
                shared ({entry.allowedAgents.length})
              </Badge>
            )}
          </div>
          {entry.label && (
            <p className="text-[11px] text-muted-foreground truncate">{entry.label}</p>
          )}
        </div>
        <Badge variant="outline" className={cn("text-[10px] shrink-0 gap-1 border", meta.color)}>
          {meta.label}
        </Badge>
        <div className="flex items-center gap-1 ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {entry.readOnly ? (
            <span
              className="text-[10px] text-muted-foreground italic px-1.5"
              title="Inherited entry — edit from the owner agent's vault."
            >
              read-only
            </span>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onEdit}
                title="Edit credential"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={onDelete}
                title="Delete credential"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
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

// ── Type Card (step 1) ──

function TypeCard({ type, onClick }: { type: VaultType; onClick: () => void }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-start gap-3 p-3 rounded-lg border border-border hover:border-primary/30 hover:bg-accent/40 text-left transition-all cursor-pointer"
    >
      <div className={cn("h-9 w-9 rounded-md flex items-center justify-center shrink-0 border", meta.color)}>
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{meta.label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{meta.description}</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1 italic">{meta.example}</p>
      </div>
    </button>
  );
}

// ── Empty state type pill ──

function TypePill({ type, onClick }: { type: VaultType; onClick: () => void }) {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-3 py-2 hover:opacity-80 transition-opacity cursor-pointer text-left",
        meta.color,
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      <div>
        <p className="text-[11px] font-medium leading-none">{meta.label}</p>
        <p className="text-[10px] opacity-60 mt-0.5">{meta.description}</p>
      </div>
    </button>
  );
}

// ── Type-specific form bodies ──

function SmtpImapForm({
  form,
  errors,
  onChange,
  defaultPort,
  defaultSecure,
}: {
  form: FormState;
  errors: FormErrors;
  onChange: (patch: Partial<FormState>) => void;
  defaultPort: string;
  defaultSecure: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Mailbox account"
        hint="Group SMTP+IMAP of the same mailbox by giving them the same account name (e.g. 'work', 'personal'). Optional — when empty the entry stands alone."
      >
        <Input
          className="h-8 text-xs"
          placeholder="work"
          value={form.account}
          onChange={(e) => onChange({ account: e.target.value })}
        />
      </Field>
      <Field label="Host" required error={errors.host}>
        <Input
          className="h-8 text-xs"
          placeholder="smtp.example.com"
          value={form.host}
          onChange={(e) => onChange({ host: e.target.value })}
        />
      </Field>
      <Field label="Port" required hint={`Default: ${defaultPort}`} error={errors.port}>
        <Input
          className="h-8 text-xs"
          type="number"
          inputMode="numeric"
          placeholder={defaultPort}
          value={form.port}
          onChange={(e) => onChange({ port: e.target.value })}
        />
      </Field>
      <Field label="User" required error={errors.user}>
        <Input
          className="h-8 text-xs"
          placeholder="user@example.com"
          value={form.user}
          onChange={(e) => onChange({ user: e.target.value })}
        />
      </Field>
      <Field label="Password" required error={errors.pass}>
        <Input
          className="h-8 text-xs"
          type="password"
          placeholder="••••••••"
          value={form.pass}
          onChange={(e) => onChange({ pass: e.target.value })}
        />
      </Field>
      <Toggle
        checked={form.secure}
        onChange={(v) => onChange({ secure: v })}
        label="Use TLS / SSL"
        hint={defaultSecure ? "Enabled by default for IMAP" : "Usually false for SMTP on port 587"}
      />
    </div>
  );
}

function OauthForm({
  form,
  errors,
  onChange,
}: {
  form: FormState;
  errors: FormErrors;
  onChange: (patch: Partial<FormState>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Provider" required error={errors.provider}>
        <Input
          className="h-8 text-xs"
          placeholder="google, github, slack…"
          value={form.provider}
          onChange={(e) => onChange({ provider: e.target.value })}
        />
      </Field>
      <Field label="Access Token" required error={errors.accessToken}>
        <Input
          className="h-8 text-xs"
          type="password"
          placeholder="ya29.a0Af…"
          value={form.accessToken}
          onChange={(e) => onChange({ accessToken: e.target.value })}
        />
      </Field>
      <Field label="Refresh Token" hint="Optional">
        <Input
          className="h-8 text-xs"
          type="password"
          placeholder="1//0g…"
          value={form.refreshToken}
          onChange={(e) => onChange({ refreshToken: e.target.value })}
        />
      </Field>
      <Field label="Expires At" hint="Optional — when the access token expires">
        <Input
          className="h-8 text-xs"
          type="datetime-local"
          value={form.expiresAt}
          onChange={(e) => onChange({ expiresAt: e.target.value })}
        />
      </Field>
    </div>
  );
}

function ApiKeyForm({
  form,
  errors,
  onChange,
}: {
  form: FormState;
  errors: FormErrors;
  onChange: (patch: Partial<FormState>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Key Name" required hint='Field name to store the value under (default: "key")' error={errors.keyName}>
        <Input
          className="h-8 text-xs font-mono"
          placeholder="key"
          value={form.keyName}
          onChange={(e) => onChange({ keyName: e.target.value })}
        />
      </Field>
      <Field label="Key Value" required error={errors.keyValue}>
        <Input
          className="h-8 text-xs"
          type="password"
          placeholder="sk-…"
          value={form.keyValue}
          onChange={(e) => onChange({ keyValue: e.target.value })}
        />
      </Field>
    </div>
  );
}

function LoginForm({
  form,
  errors,
  onChange,
}: {
  form: FormState;
  errors: FormErrors;
  onChange: (patch: Partial<FormState>) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Username" required error={errors.username}>
        <Input
          className="h-8 text-xs"
          placeholder="username"
          value={form.username}
          onChange={(e) => onChange({ username: e.target.value })}
        />
      </Field>
      <Field label="Password" required error={errors.password}>
        <Input
          className="h-8 text-xs"
          type="password"
          placeholder="••••••••"
          value={form.password}
          onChange={(e) => onChange({ password: e.target.value })}
        />
      </Field>
      <Field label="URL" hint="Optional — login page URL">
        <Input
          className="h-8 text-xs"
          type="url"
          placeholder="https://example.com/login"
          value={form.url}
          onChange={(e) => onChange({ url: e.target.value })}
        />
      </Field>
    </div>
  );
}

function CustomForm({
  form,
  errors,
  onChange,
}: {
  form: FormState;
  errors: FormErrors;
  onChange: (patch: Partial<FormState>) => void;
}) {
  const updateField = (id: number, patch: Partial<CustomField>) => {
    onChange({
      customFields: form.customFields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
  };
  const addField = () => {
    const nextId = form.customFields.reduce((m, f) => Math.max(m, f.id), 0) + 1;
    onChange({ customFields: [...form.customFields, { id: nextId, key: "", value: "" }] });
  };
  const removeField = (id: number) => {
    onChange({ customFields: form.customFields.filter((f) => f.id !== id) });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <label className="text-xs font-medium text-foreground">
          Fields <span className="text-destructive">*</span>
        </label>
        {form.customFields.map((f) => (
          <div key={f.id} className="flex items-center gap-2">
            <Input
              className="h-8 text-xs font-mono flex-1"
              placeholder="key"
              value={f.key}
              onChange={(e) => updateField(f.id, { key: e.target.value })}
            />
            <Input
              className="h-8 text-xs flex-1"
              type="password"
              placeholder="value"
              value={f.value}
              onChange={(e) => updateField(f.id, { value: e.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => removeField(f.id)}
              disabled={form.customFields.length <= 1}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        {errors.customFields && (
          <p className="text-[10px] text-destructive leading-tight">{errors.customFields}</p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs gap-1.5"
          onClick={addField}
        >
          <Plus className="h-3 w-3" /> Add field
        </Button>
      </div>
    </div>
  );
}

// ── Share-with selector (multi-agent chip toggle) ──

function ShareWithSelector({
  ownerAgent,
  selected,
  onChange,
}: {
  ownerAgent: string;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const { agents } = useAgents();
  const others = (agents ?? []).filter((a) => a.name !== ownerAgent);

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter(n => n !== name));
    } else {
      onChange([...selected, name]);
    }
  };

  return (
    <Field
      label="Shared with"
      hint="Other agents that can read and use this credential. Owner agent is always implicit. Owner-private if no one is selected."
    >
      {others.length === 0 ? (
        <p className="text-[11px] text-muted-foreground italic">No other agents available to share with.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {others.map((a) => {
            const active = selected.includes(a.name);
            return (
              <button
                key={a.name}
                type="button"
                onClick={() => toggle(a.name)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-colors",
                  active
                    ? "bg-primary/15 border-primary/40 text-primary"
                    : "bg-card border-border/40 text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
                title={a.identity?.displayName ?? a.name}
              >
                {active && <Check className="h-3 w-3" />}
                {a.name}
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
}

// ── Main wizard dialog ──

function CredentialDialog({
  open,
  onOpenChange,
  agent,
  initial,
  isEdit,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agent: string;
  initial: { type: VaultType; service: string; label?: string; account?: string; allowedAgents?: string[] } | null;
  isEdit: boolean;
  onSaved: () => void;
}) {
  const { client } = usePolpo();

  const [step, setStep] = useState<1 | 2>(initial ? 2 : 1);
  const [form, setForm] = useState<FormState>(() => {
    if (initial) {
      const f = defaultForm(initial.type);
      f.service = initial.service;
      f.label = initial.label ?? "";
      f.account = initial.account ?? "";
      f.allowedAgents = initial.allowedAgents ?? [];
      return f;
    }
    return defaultForm("api_key");
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset state when (re)opened
  const resetTo = (init: { type: VaultType; service: string; label?: string; account?: string; allowedAgents?: string[] } | null) => {
    if (init) {
      const f = defaultForm(init.type);
      f.service = init.service;
      f.label = init.label ?? "";
      f.account = init.account ?? "";
      f.allowedAgents = init.allowedAgents ?? [];
      setForm(f);
      setStep(2);
    } else {
      setForm(defaultForm("api_key"));
      setStep(1);
    }
    setErrors({});
    setSubmitError(null);
  };

  // When dialog opens, reset internal state from props.
  // Using a key on the parent ensures fresh mount, but keep this safe regardless.
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      onOpenChange(false);
      // delay reset so the close animation runs cleanly
      setTimeout(() => resetTo(null), 150);
    } else {
      onOpenChange(true);
    }
  };

  const pickType = (t: VaultType) => {
    const fresh = defaultForm(t);
    setForm(fresh);
    setErrors({});
    setSubmitError(null);
    setStep(2);
  };

  const updateForm = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const handleSave = async () => {
    const errs = validateForm(form, isEdit);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setSubmitError(null);
    try {
      const credentials = buildCredentials(form);
      // Mailbox account is only meaningful for smtp/imap entries — clear
      // for any other type so users don't accidentally tag api_keys etc.
      const accountValue = (form.type === "smtp" || form.type === "imap")
        ? (form.account.trim() || undefined)
        : undefined;
      // Owner cannot share with itself; UI selector should already prevent
      // it but filter defensively.
      const allowedAgents = form.allowedAgents.filter(n => n && n !== agent);
      if (isEdit) {
        await client.patchVaultEntry(agent, form.service.trim(), {
          type: form.type,
          label: form.label.trim() || undefined,
          account: accountValue,
          // Always send the list on patch so the user can clear sharing
          // by deselecting everything (REPLACE semantics).
          allowedAgents,
          credentials,
        });
        toast.success(`Updated credential "${form.service.trim()}"`);
      } else {
        await client.saveVaultEntry({
          agent,
          service: form.service.trim(),
          type: form.type,
          label: form.label.trim() || undefined,
          account: accountValue,
          ...(allowedAgents.length > 0 ? { allowedAgents } : {}),
          credentials,
        });
        toast.success(`Added credential "${form.service.trim()}"`);
      }
      onSaved();
      handleOpenChange(false);
    } catch (e) {
      const msg = (e as Error).message ?? "Failed to save credential";
      setSubmitError(msg);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const meta = TYPE_META[form.type];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle className="text-base flex items-center gap-2">
            {step === 2 && !isEdit && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 -ml-1"
                onClick={() => setStep(1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            {isEdit
              ? `Edit ${meta.label} credential`
              : step === 1
                ? "Add credential"
                : `New ${meta.label} credential`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit
              ? `Updating "${form.service}" — leave fields blank only if you want to clear them.`
              : step === 1
                ? "Pick the kind of credential you want to store."
                : meta.example}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-5 max-h-[65vh] overflow-y-auto">
          {step === 1 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ALL_VAULT_TYPES.map((t) => (
                <TypeCard key={t} type={t} onClick={() => pickType(t)} />
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              <Field
                label="Service"
                required
                hint={isEdit ? "Service name cannot be changed" : "Unique identifier (e.g. openai, smtp.gmail.com)"}
                error={errors.service}
              >
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="openai"
                  value={form.service}
                  onChange={(e) => updateForm({ service: e.target.value })}
                  disabled={isEdit}
                  autoFocus={!isEdit}
                />
              </Field>
              <Field label="Label" hint="Optional — human-readable description">
                <Input
                  className="h-8 text-xs"
                  placeholder="Production API key"
                  value={form.label}
                  onChange={(e) => updateForm({ label: e.target.value })}
                />
              </Field>

              <div className="border-t border-border/40 pt-4">
                {form.type === "smtp" && (
                  <SmtpImapForm
                    form={form}
                    errors={errors}
                    onChange={updateForm}
                    defaultPort="587"
                    defaultSecure={false}
                  />
                )}
                {form.type === "imap" && (
                  <SmtpImapForm
                    form={form}
                    errors={errors}
                    onChange={updateForm}
                    defaultPort="993"
                    defaultSecure={true}
                  />
                )}
                {form.type === "oauth" && (
                  <OauthForm form={form} errors={errors} onChange={updateForm} />
                )}
                {form.type === "api_key" && (
                  <ApiKeyForm form={form} errors={errors} onChange={updateForm} />
                )}
                {form.type === "login" && (
                  <LoginForm form={form} errors={errors} onChange={updateForm} />
                )}
                {form.type === "custom" && (
                  <CustomForm form={form} errors={errors} onChange={updateForm} />
                )}
              </div>

              <div className="border-t border-border/40 pt-4">
                <ShareWithSelector
                  ownerAgent={agent}
                  selected={form.allowedAgents}
                  onChange={(next) => updateForm({ allowedAgents: next })}
                />
              </div>

              {submitError && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                  <p className="text-xs text-destructive">{submitError}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {step === 2 && (
          <div className="flex justify-end gap-2 px-6 pb-5 pt-2 border-t border-border/40">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleOpenChange(false)}
              className="text-xs"
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saving}
              className="text-xs gap-1.5"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              {isEdit ? "Save changes" : "Add credential"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Main Tab ──

export function AgentCredentialsTab() {
  const { state: { vaultEntries }, actions: { refetchVault }, meta: { agentName } } = useAgentDetail();
  const { client } = usePolpo();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [editing, setEditing] = useState<{ type: VaultType; service: string; label?: string; account?: string; allowedAgents?: string[] } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<VaultEntryMeta | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openAdd = () => {
    setEditing(null);
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const openEdit = (entry: VaultEntryMeta) => {
    setEditing({
      type: entry.type,
      service: entry.service,
      label: entry.label,
      account: entry.account,
      allowedAgents: entry.allowedAgents,
    });
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await client.removeVaultEntry(agentName, deleteTarget.service);
      toast.success(`Deleted credential "${deleteTarget.service}"`);
      await refetchVault();
      setDeleteTarget(null);
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleSaved = async () => {
    await refetchVault();
  };

  const headerAction = useMemo(
    () => (
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1"
        onClick={openAdd}
      >
        <Plus className="h-3 w-3" /> Add credential
      </Button>
    ),
    [],
  );

  return (
    <ScrollArea className="h-full">
      <div className="space-y-6 pr-4 pb-bottom-nav lg:pb-4">
        <div>
          <div className="flex items-center justify-between gap-2 mb-3">
            <SectionHeader
              title="Credential Vault"
              icon={KeyRound}
              count={vaultEntries.length || undefined}
            />
            {headerAction}
          </div>

          {vaultEntries.length > 0 ? (
            <div className="space-y-2">
              {vaultEntries.map((entry: VaultEntryMeta) => (
                <VaultEntryCard
                  key={entry.service}
                  entry={entry}
                  onEdit={() => openEdit(entry)}
                  onDelete={() => setDeleteTarget(entry)}
                />
              ))}
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                Encrypted with AES-256-GCM in <code className="font-mono">.polpo/vault.enc</code>.
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground max-w-sm mx-auto text-center">
              <Lock className="h-10 w-10 mb-3 opacity-40" />
              <p className="text-sm font-medium">No vault entries</p>
              <p className="text-xs text-muted-foreground/60 mt-2 leading-relaxed">
                Add service credentials for this agent. Tap a type below or use the
                Add button above.
              </p>
              <div className="grid grid-cols-2 gap-2 mt-4 w-full">
                {ALL_VAULT_TYPES.map((t) => (
                  <TypePill key={t} type={t} onClick={openAdd} />
                ))}
              </div>
              <Button
                variant="default"
                size="sm"
                className="h-8 text-xs gap-1.5 mt-5"
                onClick={openAdd}
              >
                <Plus className="h-3.5 w-3.5" /> Add credential
              </Button>
              <p className="text-[10px] text-muted-foreground/40 mt-4">
                Entries are encrypted with AES-256-GCM in{" "}
                <code className="font-mono">.polpo/vault.enc</code>.
                Provider-level auth is managed in Configuration.
              </p>
            </div>
          )}
        </div>
      </div>

      <CredentialDialog
        key={dialogKey}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        agent={agentName}
        initial={editing}
        isEdit={!!editing}
        onSaved={handleSaved}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={deleteTarget ? `Delete "${deleteTarget.service}"?` : "Delete credential?"}
        description="This will permanently remove the credential from the encrypted vault. Any tools relying on it will stop working."
        confirmLabel="Delete"
        destructive
        loading={deleting}
        onConfirm={handleDelete}
      />
    </ScrollArea>
  );
}
