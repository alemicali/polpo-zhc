/**
 * A model field: the model with its engine (ModelWithEngine) as a button that opens the shared
 * ModelPicker (the instance's authenticated providers), and a clear button. The New agent dialog
 * and the suite roles (judge, simulated user, generator, reviewer: a model + engine block) use it.
 */
import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useConfiguredProviders } from "@/hooks/use-configured-providers";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelPicker } from "@/components/shared/model-picker";
import { ModelWithEngine } from "@/components/shared/model-with-engine";
import { cn } from "@/lib/utils";

export function ModelField({
  value, onChange, engine = "polpo", fallback = "Use project default", testId, className, ariaLabel = "Model",
}: {
  value: string | undefined;
  onChange: (spec: string | undefined) => void;
  /** The engine the model runs on (shown after it): an engine id or a resolved EngineInfo. */
  engine?: Parameters<typeof ModelWithEngine>[0]["engine"];
  fallback?: string;
  testId?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const { configuredProviders, providerSources } = useConfiguredProviders();
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" role="combobox" aria-expanded={open} aria-label={ariaLabel} className="flex-1 justify-between font-normal">
            <ModelWithEngine model={value || undefined} fallback={fallback} engine={engine} size={14}
              modelClassName={cn(!value && "text-muted-foreground")} testId={testId} />
            <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[420px] p-0" align="start">
          {configuredProviders.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              No authenticated providers. Configure one in Settings → Providers first.
            </div>
          ) : (
            <ModelPicker
              configuredProviders={configuredProviders}
              providerSources={providerSources}
              value={value || null}
              onSelect={(spec) => { onChange(spec); setOpen(false); }}
              maxHeight="280px"
              heading={null}
              subheading={null}
            />
          )}
        </PopoverContent>
      </Popover>
      {value && (
        <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground" onClick={() => onChange(undefined)} aria-label="Clear model selection">
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
