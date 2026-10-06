import { ErrorBoundary } from "@/components/error-boundary";
import { lazy, Suspense, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const TerminalPage = lazy(() =>
  import("@/pages/terminal").then((m) => ({ default: m.TerminalPage })),
);
const CodingPage = lazy(() =>
  import("@/pages/coding").then((m) => ({ default: m.CodingPage })),
);

function PageLoader() {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function PersistentPageOutlet() {
  const { pathname } = useLocation();
  const isTerminal = pathname === "/terminal";
  const isCoding = pathname === "/coding";
  const isPersistentPage = isTerminal || isCoding;
  const [terminalMounted, setTerminalMounted] = useState(isTerminal);
  const [codingMounted, setCodingMounted] = useState(isCoding);

  // Once visited, keep the page mounted (adjusted during render, not in an effect).
  if (isTerminal && !terminalMounted) setTerminalMounted(true);
  if (isCoding && !codingMounted) setCodingMounted(true);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <div
        className={cn(
          "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
          isTerminal ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
        )}
        aria-hidden={!isTerminal}
      >
        {terminalMounted && (
          <Suspense fallback={<PageLoader />}>
            <TerminalPage />
          </Suspense>
        )}
      </div>

      <div
        className={cn(
          "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
          isCoding ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none",
        )}
        aria-hidden={!isCoding}
      >
        {codingMounted && (
          <Suspense fallback={<PageLoader />}>
            <CodingPage />
          </Suspense>
        )}
      </div>

      <div
        className={cn(
          "absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden",
          isPersistentPage ? "z-0 opacity-0 pointer-events-none" : "z-10 opacity-100",
        )}
        aria-hidden={isPersistentPage}
      >
        <ErrorBoundary area="questa pagina" resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </div>
    </div>
  );
}
