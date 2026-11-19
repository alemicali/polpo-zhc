/** Public paths of the connector OAuth flow (reachable without the API key). */
export const CONNECTOR_OAUTH_CALLBACK_PATH = "/api/v1/connectors/oauth/callback";
/** This instance's OAuth Client ID Metadata Document (servers that support CIMD fetch it). */
export const CONNECTOR_CLIENT_METADATA_PATH = "/api/v1/connectors/oauth/client-metadata.json";

/** The metadata document URL that goes with a redirect URI on the same origin (https only), if any. */
export function clientMetadataUrlFor(redirectUri: string): string | undefined {
  if (!redirectUri.startsWith("https://") || !redirectUri.endsWith(CONNECTOR_OAUTH_CALLBACK_PATH)) return undefined;
  return `${redirectUri.slice(0, -CONNECTOR_OAUTH_CALLBACK_PATH.length)}${CONNECTOR_CLIENT_METADATA_PATH}`;
}

/** The Client ID Metadata Document for this instance (its URL is the client_id). */
export function clientMetadataDocument(origin: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/, "");
  return {
    client_id: `${base}${CONNECTOR_CLIENT_METADATA_PATH}`,
    client_name: "Polpo",
    client_uri: "https://polpo.sh",
    redirect_uris: [`${base}${CONNECTOR_OAUTH_CALLBACK_PATH}`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}
