/** A harness connection test's result, in one line (Settings → Harnesses, the agent's Engine card). */
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { TEST_ERROR_LABELS, type HarnessTestResult } from "@/lib/harnesses-api";

/** A connection test's result, in one line. */
export function HarnessTestLine({ result }: { result: HarnessTestResult | "running" | undefined }) {
  if (!result) return null;
  if (result === "running") return <p className="flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing the connection from the Polpo server…</p>;
  return result.ok ? (
    <p className="flex items-start gap-1.5 text-success" data-testid={`harness-test-${result.harness}`}>
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>Connected in {result.latencyMs} ms{result.model ? ` · ${result.model}` : ""}{result.endpoint ? ` · ${result.endpoint}` : ""}{result.note ? ` · ${result.note}` : ""}</span>
    </p>
  ) : (
    <p className="flex items-start gap-1.5 text-destructive" data-testid={`harness-test-${result.harness}`} role="alert">
      <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{result.errorKind ? `${TEST_ERROR_LABELS[result.errorKind]}: ` : ""}{result.error ?? "The test failed"}</span>
    </p>
  );
}
