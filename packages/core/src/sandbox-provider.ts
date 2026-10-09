// Copied from lumea-labs/polpo (packages/core/src/sandbox-provider.ts) at 8ef8e9c.
// Copyright 2026-present Lumea Labs. Licensed under the Apache License, Version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0
// Unmodified: keep it in sync with upstream rather than editing it here.
/**
 * SandboxProvider — the port that opens an isolated execution environment
 * (filesystem + shell) for a single run.
 *
 * A provider is backed by whatever the host chooses: the local machine, a
 * Docker container, a Daytona sandbox, a remote microVM, … The proxy
 * execution model keeps the agent loop in the host process and drives tools
 * through the session's `fs`/`shell`, so a run is portable across backends
 * without touching the loop.
 *
 * Pure port: types only, no runtime dependencies. Adapters live in the host
 * packages (node for local/docker, a dedicated package for daytona, the
 * cloud for proprietary backends).
 */
import type { FileSystem } from "./filesystem.js";
import type { Shell } from "./shell.js";
import type {
  SandboxVolumeAccess,
  SandboxVolumeWriteBack,
} from "./runtime-sandbox.js";

export type SandboxVolumeStrategy = "mounted" | "hydrated";

/** Secret-free host resolution of one selected persistent volume. */
export interface ResolvedSandboxVolumeAttachment {
  readonly name: string;
  readonly strategy: SandboxVolumeStrategy;
  readonly mountPath: string;
  readonly access: SandboxVolumeAccess;
  readonly writeBack?: SandboxVolumeWriteBack;
  readonly revision?: string;
}

/** One run-scoped workspace plan shared by every nested execution step. */
export interface SandboxWorkspaceContext {
  readonly workDir: string;
  readonly volumes: readonly ResolvedSandboxVolumeAttachment[];
}

export interface SandboxProvider {
  /**
   * Open a session for `runId`. Returns synchronously or asynchronously
   * depending on the backend (the local provider is sync; a remote sandbox
   * resolves after acquisition).
   */
  open(runId: string): SandboxSession | Promise<SandboxSession>;
}

/**
 * A live execution environment for one run: a {@link FileSystem} + a
 * {@link Shell}, plus optional suspend/resume ({@link SandboxLifecycle}) and
 * running-time accounting ({@link SandboxUsage}).
 *
 * Callers MUST `dispose()` the session when the run ends.
 */
export interface SandboxSession {
  readonly fs: FileSystem;
  readonly shell: Shell;
  /** Host-resolved workspace used by this session, when supplied. */
  readonly workspace?: SandboxWorkspaceContext;
  /** Persist one or every manually managed hydrated volume for this lease. */
  checkpointVolume?(name?: string): Promise<void>;
  /**
   * Optional suspend/resume. When present, the caller may suspend the
   * sandbox during idle gaps (e.g. while the model is thinking) and resume
   * it on demand — the basis of running-time billing. Absent for backends
   * with no meaningful suspend (e.g. the local machine) or with native
   * per-call suspend that needs no externally-driven lifecycle.
   */
  readonly lifecycle?: SandboxLifecycle;
  /** Running-time accounting for this session, when the backend meters it. */
  usage?(): SandboxUsage;
  /** Optional host metadata used to enrich lifecycle trace events. */
  lifecycleInfo?(): SandboxLifecycleInfo;
  /** Release the session's resources. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Suspend/resume for a sandbox session. `suspend()` frees the hot resources
 * (CPU/RAM) while keeping the filesystem; `resume()` makes it runnable again.
 * Maps to Daytona stop/start, Docker pause/unpause, and similar primitives.
 */
export interface SandboxLifecycle {
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

/** Running-time accounting for a sandbox session — the billable unit. */
export interface SandboxUsage {
  runId: string;
  projectId?: string;
  /**
   * True when the run actually acquired a sandbox (touched fs/shell). A run
   * whose loop only reasons/talks never opens a session, so this is false and
   * `sandboxMs` is 0 — the resource saving the proxy model is built on.
   */
  acquired: boolean;
  /**
   * Total milliseconds the sandbox was actually RUNNING (not suspended). With
   * a {@link SandboxLifecycle}, idle gaps (the model thinking) are subtracted;
   * without one it equals the acquire→release hold. 0 when never acquired.
   */
  sandboxMs: number;
  /** Backend sandbox identifier, when applicable. */
  sandboxId?: string;
  /** Ordered lifecycle transitions observed during this run-scoped lease. */
  events?: readonly SandboxRuntimeEvent[];
}

export type SandboxRuntimeEventType =
  | "sandbox.acquire.started"
  | "sandbox.acquired"
  | "sandbox.suspended"
  | "sandbox.resumed"
  | "sandbox.release.started"
  | "sandbox.released"
  | "sandbox.rejected"
  | "sandbox.error"
  | "sandbox.volume.prepare.started"
  | "sandbox.volume.prepared"
  | "sandbox.volume.checkpoint.started"
  | "sandbox.volume.checkpointed"
  | "sandbox.volume.finalize.started"
  | "sandbox.volume.finalized"
  | "sandbox.volume.conflict";

export type SandboxRuntimeOperation =
  | "acquire"
  | "suspend"
  | "resume"
  | "release"
  | "prepare"
  | "checkpoint"
  | "finalize";
export type SandboxAcquisitionSource = "created" | "pool" | "shared";
export type SandboxReleaseOutcome = "pooled" | "destroyed" | "evicted";

export interface SandboxLifecycleInfo {
  readonly acquisitionSource?: SandboxAcquisitionSource;
  readonly releaseOutcome?: SandboxReleaseOutcome;
}

/** Provider-neutral sandbox event suitable for an existing run trace. */
export interface SandboxRuntimeEvent {
  readonly type: SandboxRuntimeEventType;
  readonly runId: string;
  readonly occurredAt: string;
  readonly projectId?: string;
  readonly sandboxId?: string;
  readonly operation?: SandboxRuntimeOperation;
  readonly source?: SandboxAcquisitionSource;
  readonly outcome?: SandboxReleaseOutcome;
  readonly error?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}
