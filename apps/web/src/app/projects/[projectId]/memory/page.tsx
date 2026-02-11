"use client";

import { MemoryEditor } from "@/components/memory/memory-editor";

export default function MemoryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Memory</h1>
        <p className="text-sm text-muted-foreground">
          Persistent project context injected into every agent prompt
        </p>
      </div>

      <MemoryEditor />
    </div>
  );
}
