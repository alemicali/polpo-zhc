// Copied from lumea-labs/polpo (packages/node/src/sandbox/local-provider.ts) at 8ef8e9c.
// Copyright 2026-present Lumea Labs. Licensed under the Apache License, Version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0
// Unmodified: keep it in sync with upstream rather than editing it here.
/**
 * LocalSandboxProvider — runs a session directly on the host machine.
 *
 * The default provider for self-hosted mode: a session is just the real
 * {@link NodeFileSystem} + {@link NodeShell}, with NO lifecycle (the local
 * machine has no meaningful suspend) and NO metering. Under a
 * {@link SandboxLease} this means the lease never suspends and behaves exactly
 * as running the tools directly — i.e. identical to today's local execution.
 */
import type { SandboxProvider, SandboxSession } from "@polpo-ai/core";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";

export class LocalSandboxProvider implements SandboxProvider {
  open(_runId: string): SandboxSession {
    return {
      fs: new NodeFileSystem(),
      shell: new NodeShell(),
      // no lifecycle → the lease never suspends (nothing to suspend locally)
      // no usage()   → nothing metered locally
      async dispose() {
        /* nothing to release on the local machine */
      },
    };
  }
}
