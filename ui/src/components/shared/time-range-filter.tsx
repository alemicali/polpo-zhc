import { useState } from "react";
import { Calendar, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  getTimeRangeAfter,
  getTimeRangeLabel,
  timeRangePresets,
  type TimeField,
  type TimeFilterState,
} from "@/lib/time-filter";

const timeFieldOptions: { value: TimeField; label: string }[] = [
  { value: "createdAt", label: "Created" },
  { value: "updatedAt", label: "Updated" },
];

export function TimeRangeFilter({
  value,
  onChange,
  onClear,
}: {
  value: TimeFilterState | null;
  onChange: (value: TimeFilterState) => void;
  onClear: () => void;
}) {
  const [field, setField] = useState<TimeField>(value?.field ?? "updatedAt");
  const activeFieldLabel = value
    ? timeFieldOptions.find((option) => option.value === value.field)?.label ?? value.field
    : null;

  const selectField = (nextField: TimeField) => {
    setField(nextField);
    if (value) {
      onChange({
        field: nextField,
        range: value.range,
        after: getTimeRangeAfter(value.range),
      });
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={value ? "default" : "outline"} size="sm" className="gap-1.5">
          <Calendar className="h-3.5 w-3.5" />
          {value ? `${activeFieldLabel}: ${getTimeRangeLabel(value.range)}` : "Time"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="mb-2 flex items-center gap-1">
          {timeFieldOptions.map((option) => (
            <Button
              key={option.value}
              variant={field === option.value ? "default" : "ghost"}
              size="sm"
              className="h-6 flex-1 text-[10px]"
              onClick={() => selectField(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <div className="space-y-0.5">
          {timeRangePresets.map((preset) => {
            const selected = value?.range === preset.value && value.field === field;
            return (
              <button
                key={preset.value}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
                )}
                onClick={() => onChange({
                  field,
                  range: preset.value,
                  after: getTimeRangeAfter(preset.value),
                })}
              >
                <div className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                  selected ? "border-primary bg-primary" : "border-muted-foreground/30",
                )}>
                  {selected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                </div>
                <span>{preset.label}</span>
              </button>
            );
          })}
        </div>

        {value && (
          <Button variant="ghost" size="sm" className="mt-1 w-full text-xs" onClick={onClear}>
            Show all time
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
