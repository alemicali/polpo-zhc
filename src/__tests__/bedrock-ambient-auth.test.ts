import { afterEach, describe, expect, it } from "vitest";
import { hasProviderCredentials, resolveApiKey, resolveModelAuthAsync } from "../llm/pi-client.js";

const saved = { token: process.env.AWS_BEARER_TOKEN_BEDROCK, region: process.env.AWS_REGION };
afterEach(() => {
  if (saved.token === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK; else process.env.AWS_BEARER_TOKEN_BEDROCK = saved.token;
  if (saved.region === undefined) delete process.env.AWS_REGION; else process.env.AWS_REGION = saved.region;
});

describe("Bedrock with a bearer token in the environment", () => {
  it("is callable, but pi-ai's '<authenticated>' marker is never passed as the API key", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "ABSKexample";
    process.env.AWS_REGION = "us-east-1";
    expect(resolveApiKey("amazon-bedrock")).toBeUndefined();
    expect(hasProviderCredentials("amazon-bedrock")).toBe(true);
    const auth = await resolveModelAuthAsync("amazon-bedrock");
    expect(auth?.apiKey).not.toBe("<authenticated>");
  });
});
