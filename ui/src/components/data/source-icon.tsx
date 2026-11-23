import { Database, FileJson, Globe, Sheet as SheetIcon } from "lucide-react";
import type { DataSourceKind } from "@/hooks/use-data";
import { cn } from "@/lib/utils";

/** A connector's icon: a database, an API, a JSON or CSV file. */
export function SourceIcon({ kind, className }: { kind: DataSourceKind; className?: string }) {
  const Icon = kind === "rest" ? Globe : kind === "json" ? FileJson : kind === "csv" ? SheetIcon : Database;
  return <Icon className={cn("size-4 shrink-0 text-primary", className)} aria-hidden="true" />;
}
