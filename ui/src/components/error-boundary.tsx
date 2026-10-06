import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  /** Where the boundary sits (shown in the message and in the console). */
  area: string;
  /** Changing it clears the error (e.g. the route, the chat session). */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
}

/**
 * Keeps a crash inside one area (a page, the chat panel) and shows what happened instead of a
 * blank screen: the error, the component stack, and ways out (retry, reload).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? "" });
    console.error(`[ErrorBoundary:${this.props.area}]`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, componentStack: "" });
  }

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const details = [`${error.name}: ${error.message}`, error.stack, componentStack && `Component stack:${componentStack}`]
      .filter(Boolean).join("\n\n");
    return (
      <div role="alert" className="m-4 flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
        <div className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Qualcosa si è rotto in {this.props.area}
        </div>
        <p className="text-xs text-muted-foreground">{error.message}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => this.setState({ error: null, componentStack: "" })}>
            <RotateCcw className="h-3.5 w-3.5" /> Riprova
          </Button>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => window.location.reload()}>
            <RefreshCw className="h-3.5 w-3.5" /> Ricarica la pagina
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => void navigator.clipboard?.writeText(details)}>
            Copia i dettagli
          </Button>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Dettagli tecnici</summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">{details}</pre>
        </details>
      </div>
    );
  }
}
