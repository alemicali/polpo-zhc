import { useState } from "react";
import { Calendar, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SegmentedControl, ToggleGroupItem } from "@/components/ui/toggle-group";
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
        <SegmentedControl
          size="sm"
          aria-label="Time field"
          className="mb-2 w-full"
          value={field}
          onValueChange={selectField}
        >
          {timeFieldOptions.map((option) => (
            <ToggleGroupItem key={option.value} value={option.value}>
              {option.label}
            </ToggleGroupItem>
          ))}
        </SegmentedControl>

        <div className="space-y-0.5">
          {timeRangePresets.map((preset) => {
            const selected = value?.range === preset.value && value.field === field;
            return (
              <button
                key={preset.value}
                type="button"
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => onChange({
                  field,
                  range: preset.value,
                  after: getTimeRangeAfter(preset.value),
                })}
              >
                <div className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-pill border",
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
          <Button variant="ghost" size="sm" className="mt-1 w-full" onClick={onClear}>
            Show all time
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
