/**
 * A harness's model gateway (Settings → Harnesses): the Vercel AI Gateway (base URL + key), or a
 * custom gateway from a preset (Cloudflare, OpenRouter, LiteLLM, Portkey, Kong, custom) with its
 * base URL, auth scheme, key, extra headers (secret ones from the vault, literal ones that are not
 * secrets), model ids and the non-Claude switch. Keys and secret headers are vault references:
 * Polpo's model relay injects them outside the computer.
 */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VaultRefPicker } from "@/components/vault/vault-ref-picker";
import {
  cloudflareIds, GATEWAY_PRESET_INFO,
  type GatewayAuthScheme, type GatewayHeader, type GatewayPreset, type HarnessGateway, type HarnessId,
} from "@/lib/harnesses-api";

const selectClass = "h-8 rounded-md border bg-transparent px-2 text-xs";

export function HarnessGatewayFields({ harness, auth, value, onChange }: {
  harness: HarnessId;
  auth: "ai-gateway" | "gateway";
  value: HarnessGateway | undefined;
  onChange: (g: HarnessGateway) => void;
}) {
  const g = value ?? {};
  const set = (patch: Partial<HarnessGateway>) => onChange({ ...g, ...patch });
  const id = harness === "codex" ? "codex" : "claude-code";

  if (auth === "ai-gateway") {
    return (
      <div className="grid gap-2 sm:grid-cols-2" data-testid={`${id}-ai-gateway`}>
        <label className="space-y-1">
          <span className="text-muted-foreground">AI Gateway key (vault entry)</span>
          <VaultRefPicker value={g.credentialRef} onChange={(ref) => set({ credentialRef: ref ?? undefined })} requiredKeys={["apiKey"]} aria-label={`${id} AI Gateway key`} />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">Base URL (optional)</span>
          <Input className="h-8 text-xs" placeholder="https://ai-gateway.vercel.sh" value={g.baseUrl ?? ""} onChange={(e) => set({ baseUrl: e.target.value.trim() || undefined })} aria-label={`${id} AI Gateway base URL`} />
        </label>
        <p className="text-micro text-muted-foreground sm:col-span-2">Model ids are the gateway's: {harness === "codex" ? "openai/gpt-5" : "anthropic/claude-sonnet-4.5"}.</p>
      </div>
    );
  }

  const preset = GATEWAY_PRESET_INFO.find((p) => p.id === (g.preset ?? "custom")) ?? GATEWAY_PRESET_INFO.at(-1)!;
  const cf = cloudflareIds(g.baseUrl);
  const choosePreset = (p: GatewayPreset) => {
    const info = GATEWAY_PRESET_INFO.find((x) => x.id === p)!;
    onChange({
      ...g, preset: p, format: harness === "codex" ? "openai-responses" : "anthropic",
      baseUrl: info.baseUrl(harness, {}), authScheme: info.authScheme,
      headers: info.headers?.(harness) ?? g.headers,
      ...(info.authScheme === "none" ? { credentialRef: undefined } : {}),
    });
  };
  const headers = g.headers ?? [];
  const setHeader = (i: number, patch: Partial<GatewayHeader>) => set({ headers: headers.map((h, j) => (j === i ? { ...h, ...patch } : h)) });

  return (
    <div className="space-y-2" data-testid={`${id}-gateway`}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-muted-foreground">Gateway</span>
          <select className={`${selectClass} w-full`} aria-label={`${id} gateway preset`} value={g.preset ?? "custom"} onChange={(e) => choosePreset(e.target.value as GatewayPreset)}>
            {GATEWAY_PRESET_INFO.filter((p) => p.id !== "vercel").map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">Key sent as</span>
          <select className={`${selectClass} w-full`} aria-label={`${id} gateway auth scheme`} value={g.authScheme ?? "bearer"}
            onChange={(e) => set({ authScheme: e.target.value as GatewayAuthScheme, ...(e.target.value === "none" ? { credentialRef: undefined } : {}) })}>
            <option value="bearer">Authorization: Bearer</option>
            <option value="x-api-key">x-api-key</option>
            <option value="none">No key (auth in a header)</option>
          </select>
        </label>
        {preset.fields?.map((f) => (
          <label key={f.key} className="space-y-1">
            <span className="text-muted-foreground">{f.label}</span>
            <Input className="h-8 text-xs" value={cf[f.key] ?? ""} aria-label={`${id} Cloudflare ${f.label}`}
              onChange={(e) => set({ baseUrl: preset.baseUrl(harness, { ...cf, [f.key]: e.target.value.trim() }) })} />
          </label>
        ))}
        <label className="space-y-1 sm:col-span-2">
          <span className="text-muted-foreground">Base URL ({harness === "codex" ? "Codex calls <base>/responses" : "Claude Code calls <base>/v1/messages"})</span>
          <Input className="h-8 text-xs" value={g.baseUrl ?? ""} onChange={(e) => set({ baseUrl: e.target.value.trim() || undefined })} aria-label={`${id} gateway base URL`} />
        </label>
        {g.authScheme !== "none" && (
          <label className="space-y-1 sm:col-span-2">
            <span className="text-muted-foreground">Gateway key (vault entry)</span>
            <VaultRefPicker value={g.credentialRef} onChange={(ref) => set({ credentialRef: ref ?? undefined })} requiredKeys={["apiKey"]} aria-label={`${id} gateway key`} />
          </label>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-2 text-muted-foreground">
          Extra headers
          <Button type="button" size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => set({ headers: [...headers, { name: "" }] })} aria-label={`${id} add header`}>
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
        {headers.map((h, i) => {
          const secret = h.value === undefined;
          return (
            <div key={i} className="grid items-center gap-1.5 sm:grid-cols-[10rem_7rem_1fr_auto]" data-testid={`${id}-header-${i}`}>
              <Input className="h-8 text-xs" placeholder="header-name" value={h.name} onChange={(e) => setHeader(i, { name: e.target.value.trim() })} aria-label={`${id} header ${i + 1} name`} />
              <select className={selectClass} aria-label={`${id} header ${i + 1} kind`} value={secret ? "secret" : "literal"}
                onChange={(e) => setHeader(i, e.target.value === "secret" ? { value: undefined } : { value: "", credentialRef: undefined, field: undefined, prefix: undefined })}>
                <option value="secret">Secret (vault)</option>
                <option value="literal">Literal value</option>
              </select>
              {secret ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Input className="h-8 w-20 text-xs" placeholder="prefix" value={h.prefix ?? ""} onChange={(e) => setHeader(i, { prefix: e.target.value || undefined })} aria-label={`${id} header ${i + 1} prefix`} />
                  <div className="min-w-40 flex-1"><VaultRefPicker value={h.credentialRef} onChange={(ref) => setHeader(i, { credentialRef: ref ?? undefined })} aria-label={`${id} header ${i + 1} vault entry`} /></div>
                  <Input className="h-8 w-24 text-xs" placeholder="field" value={h.field ?? ""} onChange={(e) => setHeader(i, { field: e.target.value.trim() || undefined })} aria-label={`${id} header ${i + 1} field`} />
                </div>
              ) : (
                <Input className="h-8 text-xs" placeholder="value (not a secret)" value={h.value ?? ""} onChange={(e) => setHeader(i, { value: e.target.value })} aria-label={`${id} header ${i + 1} value`} />
              )}
              <Button type="button" size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => set({ headers: headers.filter((_, j) => j !== i) })} aria-label={`${id} remove header ${i + 1}`}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          );
        })}
      </div>

      <div className="grid gap-2 sm:grid-cols-4">
        {(["main", ...(harness === "claude-code" ? ["haiku", "sonnet", "opus"] as const : [])] as const).map((slot) => (
          <label key={slot} className="space-y-1">
            <span className="text-muted-foreground">{slot === "main" ? "Model" : `${slot} alias`}</span>
            <Input className="h-8 text-xs" value={g.models?.[slot] ?? ""} aria-label={`${id} gateway model ${slot}`}
              onChange={(e) => {
                const v = e.target.value.trim() || undefined;
                const models = { main: g.models?.main ?? "", ...g.models, [slot]: v };
                set({ models: Object.values(models).some(Boolean) ? (models as HarnessGateway["models"]) : undefined });
              }} />
          </label>
        ))}
      </div>
      {harness === "claude-code" && (
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!g.nonClaude} onChange={(e) => set({ nonClaude: e.target.checked || undefined })} aria-label="Non-Claude models" />
          Non-Claude models (no experimental betas, adaptive thinking or effort; every alias goes to the model above unless set)
        </label>
      )}
      <p className="text-micro text-muted-foreground">{preset.hint}</p>
    </div>
  );
}
