import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type {
  OAuthAuth,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type { OAuthProfile } from "./types.js";

export interface PiOAuthProviderDefinition {
  id: string;
  name: string;
  loginLabel?: string;
  isSubscription: boolean;
  runtime: OAuthAuth;
}

let providerCache: PiOAuthProviderDefinition[] | undefined;

/** Return the OAuth capabilities owned by the installed pi-ai providers. */
export function listPiOAuthProviders(): PiOAuthProviderDefinition[] {
  if (!providerCache) {
    providerCache = builtinProviders()
      .flatMap((provider) => {
        const runtime = provider.auth.oauth;
        if (!runtime) return [];
        return [{
          id: provider.id,
          name: runtime.name,
          loginLabel: runtime.loginLabel,
          isSubscription: runtime.isSubscription === true,
          runtime,
        }];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  return providerCache;
}

export function getPiOAuthRuntime(providerId: string): OAuthAuth | undefined {
  return listPiOAuthProviders().find((provider) => provider.id === providerId)?.runtime;
}

/** Convert Polpo's multi-profile record to pi-ai's canonical credential. */
export function oauthCredentialFromProfile(profile: OAuthProfile): OAuthCredential {
  return {
    ...profile.extra,
    ...(profile.email ? { email: profile.email } : {}),
    type: "oauth",
    access: profile.access,
    refresh: profile.refresh ?? "",
    expires: profile.expires ?? 0,
  };
}
