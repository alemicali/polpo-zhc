"use client";

import { useRef, useEffect, useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useEvents, type SSEEvent } from "@orchestra/react";
import {
  getEventIcon,
  getEventCategory,
  getEventSeverity,
  summarizeEvent,
  formatTimestamp,
  formatTimestampMinute,
  EVENT_CATEGORY_COLORS,
  SEVERITY_ROW_COLORS,
  type EventCategory,
} from "@/lib/orchestra";
import { cn } from "@/lib/utils";
import { Search, ArrowDown, ChevronRight } from "lucide-react";

const CATEGORIES: { key: EventCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "task", label: "Task" },
  { key: "agent", label: "Agent" },
  { key: "assessment", label: "Assess" },
  { key: "plan", label: "Plan" },
  { key: "system", label: "System" },
];

interface TimeGroup {
  key: string; // "HH:MM"
  events: SSEEvent[];
}

function groupByMinute(events: SSEEvent[]): TimeGroup[] {
  const groups: TimeGroup[] = [];
  let current: TimeGroup | null = null;
  for (const e of events) {
    const key = e.timestamp ? formatTimestampMinute(e.timestamp) : "—";
    if (!current || current.key !== key) {
      current = { key, events: [] };
      groups.push(current);
    }
    current.events.push(e);
  }
  return groups;
}

export function EventTimeline() {
  const { events } = useEvents();
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [showTicks, setShowTicks] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      // Hide tick events unless explicitly shown
      if (!showTicks && e.event === "orchestrator:tick") return false;
      // Category filter
      if (category !== "all" && getEventCategory(e.event) !== category) return false;
      // Text filter
      if (
        filter &&
        !e.event.toLowerCase().includes(filter.toLowerCase()) &&
        !summarizeEvent(e).toLowerCase().includes(filter.toLowerCase())
      )
        return false;
      return true;
    });
  }, [events, filter, category, showTicks]);

  const groups = useMemo(() => groupByMinute(filtered), [filtered]);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  return (
    <Card className="flex flex-col h-[calc(100vh-200px)]">
      <CardHeader className="pb-3 space-y-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Event Timeline</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {filtered.length}
            {filtered.length !== events.length && (
              <span className="text-muted-foreground/50">
                {" "}of {events.length}
              </span>
            )}
            {" "}events
          </span>
        </div>

        {/* Search + category chips */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Filter events..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <div className="flex gap-1">
            {CATEGORIES.map((cat) => (
              <Button
                key={cat.key}
                variant={category === cat.key ? "default" : "outline"}
                size="sm"
                className="h-7 text-[11px] px-2"
                onClick={() => setCategory(cat.key)}
              >
                {cat.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Show ticks toggle */}
        <div className="flex items-center gap-2">
          <Switch
            id="show-ticks"
            checked={showTicks}
            onCheckedChange={setShowTicks}
            className="scale-75"
          />
          <label
            htmlFor="show-ticks"
            className="text-xs text-muted-foreground cursor-pointer select-none"
          >
            Show tick events
          </label>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-hidden p-0 relative">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-full overflow-auto px-4 pb-4"
        >
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {events.length === 0
                ? "Waiting for events..."
                : "No events match the current filters"}
            </p>
          ) : (
            <div className="space-y-1">
              {groups.map((group) => (
                <div key={group.key + group.events[0]?.id}>
                  {/* Time group header */}
                  <div className="sticky top-0 z-10 flex items-center gap-2 py-1 bg-background/95 backdrop-blur-sm">
                    <span className="text-[10px] font-mono text-muted-foreground/60 tabular-nums w-12">
                      {group.key}
                    </span>
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-[10px] text-muted-foreground/40 tabular-nums">
                      {group.events.length}
                    </span>
                  </div>

                  {/* Events in group */}
                  {group.events.map((event, i) => {
                    const { icon, color } = getEventIcon(event.event);
                    const cat = getEventCategory(event.event);
                    const severity = getEventSeverity(event.event);
                    const isExpanded = expandedEvent === (event.id ?? `${group.key}-${i}`);
                    const eventKey = event.id ?? `${group.key}-${i}`;

                    return (
                      <div key={eventKey}>
                        <div
                          className={cn(
                            "flex items-start gap-2 rounded px-2 py-1.5 text-xs cursor-pointer transition-colors",
                            "hover:bg-muted/40",
                            SEVERITY_ROW_COLORS[severity],
                            isExpanded && "bg-muted/30"
                          )}
                          onClick={() =>
                            setExpandedEvent(isExpanded ? null : eventKey)
                          }
                        >
                          {/* Expand indicator */}
                          <ChevronRight
                            className={cn(
                              "h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/40 transition-transform",
                              isExpanded && "rotate-90"
                            )}
                          />

                          {/* Icon */}
                          <span
                            className={cn(
                              "shrink-0 w-4 text-center font-mono mt-0.5",
                              color
                            )}
                          >
                            {icon}
                          </span>

                          {/* Category badge */}
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[9px] h-4 px-1.5 shrink-0",
                              EVENT_CATEGORY_COLORS[cat]
                            )}
                          >
                            {event.event.split(":")[1] ?? event.event}
                          </Badge>

                          {/* Summary */}
                          <span className="flex-1 text-muted-foreground truncate">
                            {summarizeEvent(event)}
                          </span>

                          {/* Timestamp */}
                          {event.timestamp && (
                            <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums font-mono">
                              {formatTimestamp(event.timestamp)}
                            </span>
                          )}
                        </div>

                        {/* Expanded details */}
                        {isExpanded && (
                          <div className="ml-9 mr-2 mb-2 rounded bg-muted/30 border p-3">
                            <div className="text-[10px] text-muted-foreground/60 mb-1 font-mono">
                              {event.event}
                              {event.id && (
                                <span className="ml-2">id: {event.id}</span>
                              )}
                            </div>
                            <pre className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">
                              {JSON.stringify(event.data, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Scroll to bottom button */}
        {!autoScroll && (
          <Button
            variant="secondary"
            size="sm"
            className="absolute bottom-4 right-4 h-7 text-xs shadow-lg"
            onClick={() => {
              setAutoScroll(true);
              if (containerRef.current) {
                containerRef.current.scrollTop =
                  containerRef.current.scrollHeight;
              }
            }}
          >
            <ArrowDown className="mr-1 h-3 w-3" /> Latest
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
