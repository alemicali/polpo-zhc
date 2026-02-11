"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useEvents } from "@orchestra/react";
import { getEventIcon, summarizeEvent, formatTimeAgo } from "@/lib/orchestra";
import { cn } from "@/lib/utils";
import { useRef, useEffect } from "react";

export function EventFeed() {
  const { events } = useEvents();
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new events
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [events.length]);

  // Filter out tick events for the feed — too noisy
  const feedEvents = events.filter((e) => e.event !== "orchestrator:tick");
  const recent = feedEvents.slice(-50);

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Event Feed</CardTitle>
      </CardHeader>
      <CardContent className="flex-1 p-0">
        <div
          ref={containerRef}
          className="max-h-[400px] overflow-auto px-4 pb-4"
        >
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              Waiting for events…
            </p>
          ) : (
            <div className="space-y-1">
              {recent.map((event, i) => {
                const { icon, color } = getEventIcon(event.event);
                return (
                  <div
                    key={event.id ?? i}
                    className="flex items-start gap-2 py-1 text-xs"
                  >
                    <span className={cn("shrink-0 w-4 text-center font-mono", color)}>
                      {icon}
                    </span>
                    <span className="flex-1 text-muted-foreground truncate">
                      {summarizeEvent(event)}
                    </span>
                    {event.timestamp && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums">
                        {formatTimeAgo(event.timestamp)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
