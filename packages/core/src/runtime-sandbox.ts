// Copied from lumea-labs/polpo (packages/core/src/runtime-sandbox.ts) at 8ef8e9c.
// Copyright 2026-present Lumea Labs. Licensed under the Apache License, Version 2.0:
// http://www.apache.org/licenses/LICENSE-2.0
// Unmodified: keep it in sync with upstream rather than editing it here.
/**
 * Provider-neutral runtime sandbox policy.
 *
 * Core carries the caller's isolation preference through RunnerConfig; the
 * host sandbox provider decides how to materialize exclusive reuse, fresh
 * allocation, or explicit project-scoped sharing.
 */

export type SandboxIsolation = "reuse" | "fresh" | "shared";
export type SandboxReleasePolicy = "pool" | "destroy";
export type SandboxVolumeAccess = "read-only" | "read-write";
export type SandboxVolumeWriteBack = "auto" | "manual";

export const SANDBOX_VOLUME_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,62}$/;
export const SANDBOX_VOLUMES_MAX = 32;

/**
 * A caller-visible selection of a host-defined persistent volume.
 *
 * The host owns backend credentials, strategy, and mount path. Lower
 * precedence tiers may remove volumes or narrow policy, but cannot add a new
 * name or widen inherited access.
 */
export interface RuntimeSandboxVolumeSelection {
  name: string;
  access?: SandboxVolumeAccess;
  writeBack?: SandboxVolumeWriteBack;
}

export const SANDBOX_IDLE_TTL_MINUTES_MAX = 7 * 24 * 60;

export interface RuntimeSandboxLifecycleOptions {
  /** What the host should do after the outer run releases the sandbox. */
  onRelease?: SandboxReleasePolicy;
  /**
   * Stop a pooled sandbox after this many minutes without activity.
   * Hosts may enforce this at minute precision. Only applies to `pool`.
   */
  stopAfterIdleMinutes?: number;
  /**
   * Delete a stopped sandbox after this many minutes. `0` requests deletion
   * immediately after stop. Only applies to `pool`.
   */
  deleteAfterStopMinutes?: number;
  /**
   * Legacy compressed lifecycle control. Hosts preserve its historical
   * semantics when it is supplied on its own.
   *
   * @deprecated Use `stopAfterIdleMinutes` and `deleteAfterStopMinutes`.
   */
  idleTtlMinutes?: number;
}

export interface RuntimeSandboxOptions {
  /**
   * `reuse` lets the host reuse a warm project sandbox when available.
   * `fresh` requests one clean sandbox for the outer run. `shared` opts into
   * a host-managed project sandbox that concurrent outer runs may use. Root
   * tools and nested loop steps always share one lease inside their outer run.
   */
  isolation?: SandboxIsolation;
  lifecycle?: RuntimeSandboxLifecycleOptions;
  /** Named host-defined volumes available to this sandbox run. */
  volumes?: RuntimeSandboxVolumeSelection[];
}

const VALID_ISOLATION: ReadonlySet<string> = new Set(["reuse", "fresh", "shared"]);
const VALID_RELEASE_POLICY: ReadonlySet<string> = new Set(["pool", "destroy"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validIdleTtlMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 1
    && (value as number) <= SANDBOX_IDLE_TTL_MINUTES_MAX;
}

function validDeleteAfterStopMinutes(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= 0
    && (value as number) <= SANDBOX_IDLE_TTL_MINUTES_MAX;
}

function normalizeVolumeSelections(
  value: unknown,
): RuntimeSandboxVolumeSelection[] | undefined {
  if (!Array.isArray(value) || value.length > SANDBOX_VOLUMES_MAX) return undefined;
  const names = new Set<string>();
  const normalized: RuntimeSandboxVolumeSelection[] = [];
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) return undefined;
    const name = candidate.name;
    if (
      typeof name !== "string"
      || !SANDBOX_VOLUME_NAME_PATTERN.test(name)
      || names.has(name)
    ) {
      return undefined;
    }
    const access = candidate.access;
    if (
      access !== undefined
      && access !== "read-only"
      && access !== "read-write"
    ) {
      return undefined;
    }
    const writeBack = candidate.writeBack;
    if (
      writeBack !== undefined
      && writeBack !== "auto"
      && writeBack !== "manual"
    ) {
      return undefined;
    }
    if (access === "read-only" && writeBack !== undefined) return undefined;
    names.add(name);
    normalized.push({
      name,
      ...(access === undefined ? {} : { access }),
      ...(writeBack === undefined ? {} : { writeBack }),
    });
  }
  return normalized;
}

function normalizeRuntimeSandboxOptions(value: unknown): RuntimeSandboxOptions | undefined {
  if (!isPlainRecord(value)) return undefined;
  const isolation = (value as { isolation?: unknown }).isolation;
  const rawLifecycle = (value as { lifecycle?: unknown }).lifecycle;
  const normalized: RuntimeSandboxOptions = {};

  if (typeof isolation === "string" && VALID_ISOLATION.has(isolation)) {
    normalized.isolation = isolation as SandboxIsolation;
  }

  if (isPlainRecord(rawLifecycle)) {
    const lifecycle = rawLifecycle as {
      onRelease?: unknown;
      stopAfterIdleMinutes?: unknown;
      deleteAfterStopMinutes?: unknown;
      idleTtlMinutes?: unknown;
    };
    const normalizedLifecycle: RuntimeSandboxLifecycleOptions = {};
    if (
      typeof lifecycle.onRelease === "string"
      && VALID_RELEASE_POLICY.has(lifecycle.onRelease)
    ) {
      normalizedLifecycle.onRelease = lifecycle.onRelease as SandboxReleasePolicy;
    }
    if (normalizedLifecycle.onRelease !== "destroy") {
      // Preserve legacy payloads deterministically. Strict API schemas reject
      // mixed legacy/new controls, but this lenient resolver may receive
      // untyped persisted config from older hosts.
      if (validIdleTtlMinutes(lifecycle.idleTtlMinutes)) {
        normalizedLifecycle.idleTtlMinutes = lifecycle.idleTtlMinutes;
      } else {
        if (validIdleTtlMinutes(lifecycle.stopAfterIdleMinutes)) {
          normalizedLifecycle.stopAfterIdleMinutes = lifecycle.stopAfterIdleMinutes;
        }
        if (validDeleteAfterStopMinutes(lifecycle.deleteAfterStopMinutes)) {
          normalizedLifecycle.deleteAfterStopMinutes = lifecycle.deleteAfterStopMinutes;
        }
      }
    }
    if (Object.keys(normalizedLifecycle).length > 0) {
      normalized.lifecycle = normalizedLifecycle;
    }
  }

  if (Object.prototype.hasOwnProperty.call(value, "volumes")) {
    const volumes = normalizeVolumeSelections(
      (value as { volumes?: unknown }).volumes,
    );
    if (volumes !== undefined) normalized.volumes = volumes;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export class SandboxVolumeGrantError extends Error {
  readonly code = "sandbox_volume_not_granted";

  constructor(readonly volumeName: string) {
    super(`Sandbox volume is not granted by the parent policy: ${volumeName}`);
    this.name = "SandboxVolumeGrantError";
  }
}

function narrowVolumeSelection(
  inherited: RuntimeSandboxVolumeSelection,
  requested: RuntimeSandboxVolumeSelection,
): RuntimeSandboxVolumeSelection {
  const access: SandboxVolumeAccess | undefined =
    inherited.access === "read-only" || requested.access === "read-only"
      ? "read-only"
      : requested.access ?? inherited.access;
  const writeBack: SandboxVolumeWriteBack | undefined = access === "read-only"
    ? undefined
    : inherited.writeBack === "manual" || requested.writeBack === "manual"
      ? "manual"
      : requested.writeBack ?? inherited.writeBack;
  return {
    name: inherited.name,
    ...(access === undefined ? {} : { access }),
    ...(writeBack === undefined ? {} : { writeBack }),
  };
}

function narrowVolumeSelections(
  inherited: RuntimeSandboxVolumeSelection[],
  requested: RuntimeSandboxVolumeSelection[],
): RuntimeSandboxVolumeSelection[] {
  const grants = new Map(inherited.map((volume) => [volume.name, volume]));
  return requested.map((volume) => {
    const grant = grants.get(volume.name);
    if (!grant) throw new SandboxVolumeGrantError(volume.name);
    return narrowVolumeSelection(grant, volume);
  });
}

export function resolveRuntimeSandboxOptions(
  settings?: { sandbox?: RuntimeSandboxOptions },
  agent?: { sandbox?: RuntimeSandboxOptions },
  request?: { sandbox?: RuntimeSandboxOptions },
): RuntimeSandboxOptions | undefined {
  const merged: RuntimeSandboxOptions = {};
  for (const source of [settings?.sandbox, agent?.sandbox, request?.sandbox]) {
    const normalized = normalizeRuntimeSandboxOptions(source);
    if (normalized?.isolation !== undefined) merged.isolation = normalized.isolation;
    if (normalized?.volumes !== undefined) {
      merged.volumes = merged.volumes === undefined
        ? normalized.volumes.map((volume) => ({ ...volume }))
        : narrowVolumeSelections(merged.volumes, normalized.volumes);
    }
    if (normalized?.lifecycle) {
      const lifecycle = merged.lifecycle ?? {};
      if (normalized.lifecycle.onRelease !== undefined) {
        lifecycle.onRelease = normalized.lifecycle.onRelease;
        if (lifecycle.onRelease === "destroy") {
          delete lifecycle.stopAfterIdleMinutes;
          delete lifecycle.deleteAfterStopMinutes;
          delete lifecycle.idleTtlMinutes;
        }
      }
      if (lifecycle.onRelease !== "destroy") {
        if (normalized.lifecycle.idleTtlMinutes !== undefined) {
          delete lifecycle.stopAfterIdleMinutes;
          delete lifecycle.deleteAfterStopMinutes;
          lifecycle.idleTtlMinutes = normalized.lifecycle.idleTtlMinutes;
        } else {
          if (normalized.lifecycle.stopAfterIdleMinutes !== undefined) {
            delete lifecycle.idleTtlMinutes;
            lifecycle.stopAfterIdleMinutes = normalized.lifecycle.stopAfterIdleMinutes;
          }
          if (normalized.lifecycle.deleteAfterStopMinutes !== undefined) {
            delete lifecycle.idleTtlMinutes;
            lifecycle.deleteAfterStopMinutes = normalized.lifecycle.deleteAfterStopMinutes;
          }
        }
      }
      if (Object.keys(lifecycle).length > 0) merged.lifecycle = lifecycle;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
