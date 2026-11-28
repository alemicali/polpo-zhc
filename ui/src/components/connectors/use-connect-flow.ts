/**
 * The connect flow shared by catalog cards, custom connectors and Reconnect:
 *
 *   setup (pre-registered OAuth app missing) → details (URL / region / token) → working
 *   → authorizing (OAuth window open) → done | error
 *
 * Every step that may open the sign-in window runs inside a click handler (`open`, `begin`), so
 * the window is opened synchronously and popup blockers let it through; when it is blocked the
 * dialog offers an "Open sign-in page" link instead. No state is set from effects.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ConnectorRequestError, connectorsApi, isIdentityConnector, missingOAuthApp, openAuthWindow, waitForOAuth,
  type CatalogEntry, type Connector, type ConnectorInput, type ConnectorScope, type OAuthApp,
} from "@/lib/connectors-api";

export type ConnectPhase = "idle" | "setup" | "details" | "working" | "authorizing" | "done" | "error";

export interface ConnectTarget {
  /** Catalog entry being connected (absent for custom connectors). */
  entry?: CatalogEntry;
  /** Existing connector (Reconnect, or the one just created). */
  connector?: Connector;
  /** Custom connector to create first. */
  create?: ConnectorInput;
  /** Shared app selected after a registration was refused. */
  oauthApp?: string;
  /**
   * Add another account of `entry` (a second Gmail inbox…): a new connector (gmail-2…) even though
   * one exists, after asking its display name (`name` is the suggested one).
   */
  another?: boolean;
  name?: string;
  /**
   * A new connector of `entry` whose type (organization, personal, per identity) is picked first,
   * with its name (`scope`: the type preselected).
   */
  choose?: boolean;
  scope?: ConnectorScope;
}

export interface ConnectDetails {
  url?: string;
  bearerToken?: string;
  /** Display name of another account. */
  name?: string;
  /** The type picked for a new connector (default: the organization's). */
  scope?: ConnectorScope;
}

export interface ConnectState {
  phase: ConnectPhase;
  target: ConnectTarget | null;
  connector?: Connector;
  error?: string;
  oauthApp?: string;
  /** Authorization URL to open by hand when the window was blocked. */
  fallbackUrl?: string;
  toolCount?: number;
}

/** True when the entry needs the person to type something before connecting. */
export function needsDetails(entry: CatalogEntry | undefined, connector: Connector | undefined): boolean {
  if (connector) return connector.auth.type === "bearer" && !connector.secrets.bearerToken;
  if (!entry) return false;
  return !!entry.urlTemplate || (entry.variants?.length ?? 0) > 1 || entry.auth === "bearer";
}

const usesOAuth = (target: ConnectTarget, details: ConnectDetails = {}) =>
  // a per-identity connector signs in per account, later: nothing opens now
  (details.scope ?? target.create?.scope ?? target.scope)?.kind === "identity" ? false
  : target.connector ? target.connector.auth.type === "oauth" && !isIdentityConnector(target.connector)
  : target.create ? target.create.auth?.type === "oauth"
  : target.entry ? target.entry.auth === "oauth" || target.entry.auth === "oauth_preregistered"
  : false;

export function useConnectFlow({
  connectors, oauthApps, onChanged,
}: {
  connectors: Connector[];
  oauthApps: OAuthApp[];
  /** A connector was created / changed by the flow (put it in the list). */
  onChanged?: (connector: Connector) => void;
}) {
  const [state, setState] = useState<ConnectState>({ phase: "idle", target: null });
  const abort = useRef<AbortController | null>(null);
  const popupRef = useRef<Window | null>(null);
  const onChangedRef = useRef(onChanged);
  useEffect(() => { onChangedRef.current = onChanged; });

  const closePopup = () => {
    try { popupRef.current?.close(); } catch { /* cross-origin */ }
    popupRef.current = null;
  };

  const run = useCallback(async (target: ConnectTarget, details: ConnectDetails, popup: Window | null) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    popupRef.current = popup;
    setState({ phase: "working", target });
    const fail = (error: unknown) => {
      if (ctrl.signal.aborted) return;
      closePopup();
      setState((s) => ({
        ...s, phase: "error", error: error instanceof Error ? error.message : String(error),
        oauthApp: error instanceof ConnectorRequestError ? error.oauthApp : undefined,
      }));
    };
    try {
      let connector = target.connector
        ?? (target.entry && !target.another && !target.choose ? connectors.find((c) => c.catalogId === target.entry!.id) : undefined);
      const scope = details.scope ?? target.scope;
      const perIdentity = scope?.kind === "identity";
      // per identity: each account brings its own token later
      const secrets = details.bearerToken && !perIdentity ? { bearerToken: details.bearerToken.trim() } : undefined;
      const name = (details.name ?? target.name)?.trim();
      if (!connector) {
        // another account: the server gives it the next free id (gmail-2…) and its own sign-in
        const input: ConnectorInput = target.create ?? {
          catalogId: target.entry!.id, ...(name ? { name } : {}), ...(details.url ? { url: details.url } : {}), ...(secrets ? { secrets } : {}),
          ...(scope && scope.kind !== "org" ? { scope } : {}),
        };
        connector = await connectorsApi.create(input);
      } else {
        // Older catalog connectors may predate the shared app requirement.
        const catalogApp = target.entry?.auth === "oauth_preregistered" && connector.auth.type === "oauth"
          && !connector.auth.oauth?.app && !connector.auth.oauth?.clientId && !connector.secrets.oauth.authorized
          ? target.entry.oauth?.app ?? target.entry.id : undefined;
        const selectedApp = target.oauthApp ?? catalogApp;
        const app = selectedApp !== connector.auth.oauth?.app ? selectedApp : undefined;
        if (app || details.url || secrets) {
          connector = await connectorsApi.update(connector.id, {
            ...(app ? { auth: { type: "oauth", oauth: { app } } } : {}),
            ...(details.url ? { url: details.url } : {}),
            ...(secrets ? { secrets } : {}),
          });
        }
      }
      if (ctrl.signal.aborted) return;
      onChangedRef.current?.(connector);
      setState((s) => ({ ...s, connector, target: { ...s.target, connector } }));
      if (isIdentityConnector(connector)) {
        // nobody signs in to the connector itself: each identity adds its accounts next
        closePopup();
        setState((s) => ({ ...s, phase: "done" }));
        return;
      }

      if (connector.auth.type === "oauth") {
        const start = await connectorsApi.startOAuth(connector.id);
        if (ctrl.signal.aborted) return;
        if (!start.authorized && start.authorizationUrl) {
          let opened = false;
          if (popup && !popup.closed) {
            try { popup.location.href = start.authorizationUrl; opened = true; } catch { opened = false; }
          }
          if (!opened) { closePopup(); popup = null; }
          setState((s) => ({ ...s, phase: "authorizing", ...(opened ? {} : { fallbackUrl: start.authorizationUrl }) }));
          const outcome = await waitForOAuth(connector.id, popup, { signal: ctrl.signal });
          if (ctrl.signal.aborted) return;
          if (outcome.kind === "cancelled") {
            setState((s) => ({ ...s, phase: "error", error: "Sign-in was cancelled before it finished." }));
            return;
          }
          if (outcome.kind === "failed") { fail(outcome.error); return; }
          onChangedRef.current?.(outcome.connector);
          if (outcome.kind === "authorized_with_error") {
            setState((s) => ({ ...s, connector: outcome.connector, phase: "error", error: `Signed in, but the first connection failed: ${outcome.error}` }));
            return;
          }
          setState((s) => ({ ...s, connector: outcome.connector, phase: "done", toolCount: outcome.connector.toolCount }));
          return;
        }
        closePopup();
      } else {
        closePopup();
      }
      const result = await connectorsApi.test(connector.id);
      if (ctrl.signal.aborted) return;
      onChangedRef.current?.(result.connector);
      if (!result.ok) {
        setState((s) => ({ ...s, connector: result.connector, phase: "error", error: result.error ?? "Could not connect" }));
        return;
      }
      setState((s) => ({ ...s, connector: result.connector, phase: "done", toolCount: result.tools?.length ?? result.connector.toolCount }));
    } catch (error) {
      fail(error);
    }
  }, [connectors]);

  /** Start (from a click): asks for setup / details first, else connects right away. */
  const open = useCallback((target: ConnectTarget) => {
    // an explicit app (the registration was refused: "Set up OAuth app") or one the catalog entry still needs
    const missingApp = target.oauthApp ?? (target.entry && missingOAuthApp(target.entry, oauthApps, target.connector));
    if (missingApp) {
      setState({ phase: "setup", target: { ...target, oauthApp: missingApp } });
      return;
    }
    // another account first asks its name (with the other details, if any)
    if (((target.another || target.choose) && !target.connector) || needsDetails(target.entry, target.connector)) {
      setState({ phase: "details", target });
      return;
    }
    const popup = usesOAuth(target) ? openAuthWindow() : null;
    void run(target, {}, popup);
  }, [oauthApps, run]);

  /** Continue from the setup / details step (a click: may open the sign-in window). */
  const begin = useCallback((details: ConnectDetails = {}) => {
    const target = state.target;
    if (!target) return;
    const popup = usesOAuth(target, details) ? openAuthWindow() : null;
    void run(target, details, popup);
  }, [run, state.target]);

  /** After saving the OAuth app: show the details / ready step. */
  const setupSaved = useCallback(() => setState((s) => ({ ...s, phase: "details" })), []);

  const openSetup = useCallback(() => {
    setState((s) => s.target && s.oauthApp
      ? { ...s, phase: "setup", target: { ...s.target, oauthApp: s.oauthApp } }
      : s);
  }, []);

  const openFallback = useCallback(() => {
    if (!state.fallbackUrl) return;
    popupRef.current = window.open(state.fallbackUrl, "_blank");
  }, [state.fallbackUrl]);

  const close = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    closePopup();
    setState({ phase: "idle", target: null });
  }, []);

  return { state, open, begin, openSetup, setupSaved, openFallback, close };
}
