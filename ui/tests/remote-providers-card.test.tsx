import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

afterEach(cleanup);

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/vault/vault-ref-picker", () => ({ VaultRefPicker: () => null }));

const api = vi.hoisted(() => ({ providers: [] as unknown[], saved: [] as unknown[] }));
vi.mock("@/lib/sandbox-api", async (importActual) => {
  const actual = await importActual<typeof import("../src/lib/sandbox-api")>();
  return {
    ...actual,
    sandboxApi: {
      ...actual.sandboxApi,
      providers: async () => api.providers,
      saveProvider: async (id: string, settings: unknown) => { api.saved.push({ id, settings }); },
    },
  };
});

import { withRemoteProvider, type RemoteProviderStatus } from "../src/lib/sandbox-api";
import { RemoteProvidersCard } from "../src/components/sandbox/remote-providers-card";

const credential = { owner: "ops", service: "daytona" };
const daytona = (over: Partial<RemoteProviderStatus> = {}): RemoteProviderStatus =>
  ({ id: "daytona", configured: true, keyFound: true, credential, api: "v0", apiUrl: "https://app.daytona.io/api", target: "us", snapshot: "polpo-runner-0.3.13", ...over });

describe("withRemoteProvider", () => {
  test("keeps the provider's options the card does not edit, and the other providers", () => {
    const next = withRemoteProvider(
      { network: { mode: "open" }, providers: { daytona: { snapshot: "s", custom: 1 }, e2b: { template: "t" } } },
      "daytona", { credential, api: "v2", image: "img" },
    );
    expect(next.providers?.daytona).toEqual({ custom: 1, credential, api: "v2", image: "img" });
    expect(next.providers?.e2b).toEqual({ template: "t" });
    expect(next.network).toEqual({ mode: "open" });
  });
});

describe("Settings → Sandbox → Daytona", () => {
  test("v0: API version and class from the snapshot are shown", async () => {
    api.providers = [daytona()];
    render(<RemoteProvidersCard />);
    const select = await screen.findByLabelText("Daytona API version");
    expect((select as HTMLSelectElement).value).toBe("v0");
    expect(screen.getByTestId("daytona-vm-class").textContent).toBe("From the snapshot");
    expect(screen.getByDisplayValue("polpo-runner-0.3.13")).toBeTruthy();
  });

  test("switching to v2 shows Linux VM and saves api v2 without the v0 API URL (snapshot kept for switching back)", async () => {
    api.providers = [daytona()];
    api.saved = [];
    render(<RemoteProvidersCard />);
    const select = await screen.findByLabelText("Daytona API version");
    fireEvent.change(select, { target: { value: "v2" } });
    expect(screen.getByTestId("daytona-vm-class").textContent).toBe("Linux VM (linux-vm)");
    expect(screen.queryByDisplayValue("https://app.daytona.io/api")).toBeNull();
    expect(screen.getByPlaceholderText("polpo-runner-vm-3")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Save/ })[0]);
    await waitFor(() => expect(api.saved).toHaveLength(1));
    expect(api.saved[0]).toEqual({ id: "daytona", settings: { credential, api: "v2", target: "us", snapshot: "polpo-runner-0.3.13" } });
  });
});
