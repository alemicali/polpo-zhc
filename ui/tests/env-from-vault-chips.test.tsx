import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { EnvFromVaultChips } from "../src/components/ai-elements/env-from-vault-chips";
import { envFromVaultRefs } from "../src/components/ai-elements/env-from-vault";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
});

describe("env_from_vault chips", () => {
  test("references from string and object forms; anything else is ignored", () => {
    expect(envFromVaultRefs({ command: "gh repo list", env_from_vault: { GH_TOKEN: "github.token", NPM: { service: "npm", key: "token" }, BAD: 3 } }))
      .toEqual([{ name: "GH_TOKEN", ref: "github.token" }, { name: "NPM", ref: "npm.token" }]);
    expect(envFromVaultRefs({ command: "ls" })).toEqual([]);
    expect(envFromVaultRefs(undefined)).toEqual([]);
    expect(envFromVaultRefs({ env_from_vault: ["x"] })).toEqual([]);
  });

  test("renders one chip per variable with its reference", async () => {
    await act(async () => root.render(<EnvFromVaultChips refs={envFromVaultRefs({ env_from_vault: { GITHUB_TOKEN: "github.token" } })} />));
    const chips = container.querySelector("[data-testid=env-from-vault]")!;
    expect(chips.textContent).toBe("GITHUB_TOKEN ← github.token");
    expect(chips.getAttribute("title")).toContain("masked as ***");
  });

  test("renders nothing without references", async () => {
    await act(async () => root.render(<EnvFromVaultChips refs={[]} />));
    expect(container.innerHTML).toBe("");
  });
});
