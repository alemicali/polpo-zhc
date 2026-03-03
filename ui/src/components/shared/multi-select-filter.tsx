import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Filter } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──

export interface FilterOption {
  /** The value used for selection tracking */
  value: string;
  /** Display label (defaults to value if omitted) */
  label?: string;
  /** Optional icon rendered before the label */
  icon?: React.ReactNode;
  /** Optional CSS class for the label (e.g. colored text) */
  labelClassName?: string;
}

export interface MultiSelectFilterProps {
  /** Icon rendered in the trigger button */
  icon?: React.ReactNode;
  /** Label text for the trigger button */
  label: string;
  /** Available options */
  options: FilterOption[];
  /** Currently selected values */
  selected: Set<string>;
  /** Called with the toggled value */
  onToggle: (value: string) => void;
  /** Called to clear all selections */
  onClear: () => void;
  /** Show loading skeletons instead of options */
  isLoading?: boolean;
  /** Popover alignment */
  align?: "start" | "center" | "end";
  /** Popover width class (default: "w-56") */
  popoverClassName?: string;
}

// ── Component ──

export function MultiSelectFilter({
  icon,
  label,
  options,
  selected,
  onToggle,
  onClear,
  isLoading = false,
  align = "start",
  popoverClassName = "w-56",
}: MultiSelectFilterProps) {
  const count = selected.size;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={count > 0 ? "default" : "outline"}
          size="sm"
          className="gap-1.5"
        >
          {icon ?? <Filter className="h-3.5 w-3.5" />}
          {label}
          {count > 0 && (
            <Badge variant="secondary" className="text-[9px] ml-1">
              {count}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn(popoverClassName, "p-2")} align={align}>
        <ScrollArea className="max-h-64">
          <div className="space-y-1">
            {isLoading ? (
              <div className="space-y-2 py-1">
                <Skeleton className="h-7 w-full rounded-md" />
                <Skeleton className="h-7 w-full rounded-md" />
                <Skeleton className="h-7 w-3/4 rounded-md" />
              </div>
            ) : options.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">
                No {label.toLowerCase()}
              </p>
            ) : (
              options.map((opt) => {
                const isSelected = selected.has(opt.value);
                return (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      isSelected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-muted",
                    )}
                    onClick={() => onToggle(opt.value)}
                  >
                    <div
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        isSelected
                          ? "bg-primary border-primary"
                          : "border-muted-foreground/30",
                      )}
                    >
                      {isSelected && (
                        <Check className="h-3 w-3 text-primary-foreground" />
                      )}
                    </div>
                    {opt.icon}
                    <span className={cn("truncate", opt.labelClassName)}>
                      {opt.label ?? opt.value}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
        {count > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full mt-1 text-xs"
            onClick={onClear}
          >
            Clear all
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
