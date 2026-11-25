/**
 * A ready-made hosted connector ("Ready-made, hosted by Polpo"): a curated server spec for one
 * vendor, its saved read-only tests, the settings and secrets it needs, and a revision number.
 * No secret value is ever in here: a template names the vault entry each credential is read from
 * and explains where to create it.
 */
import type { McpServerSpec, McpServerTestCase } from "../types.js";

/** A credential the template needs, with the vendor's instructions. */
export interface McpServerTemplateSecret {
  /** "API token" */
  label: string;
  /** Where to create it, step by step (one or two sentences). */
  howTo: string;
  /** The vendor page where it is created. */
  url?: string;
  /** The permissions / scopes to give it. */
  scopes?: string[];
  /** e.g. "Prefer a read-only token: ordering tools need a person's approval anyway." */
  recommendation?: string;
}

export interface McpServerTemplate {
  /** [a-z0-9-]: also the default server id. */
  id: string;
  name: string;
  vendor: string;
  /** "Print on demand", "Payments"… */
  category: string;
  description: string;
  /** simple-icons slug or emoji (the connector icon). */
  icon?: string;
  /** The vendor's API docs. */
  docs: string;
  /**
   * Increases with every change of the spec or tests. An installed server whose template revision is
   * lower can be upgraded: a new draft (with the diff) to review and publish.
   */
  revision: number;
  /** What changed per revision (newest first). */
  changelog: Array<{ revision: number; note: string }>;
  /** Has anyone run it against the real API? */
  maturity: { testedWithLiveApi: boolean; note?: string };
  /** One line shown before install. */
  setup: string;
  /** Instructions per secret of spec.secrets (by secret name). */
  secrets: Record<string, McpServerTemplateSecret>;
  spec: McpServerSpec;
  /** Saved tests: read-only tools only (they run at install, before publishing). */
  tests: Array<Omit<McpServerTestCase, "id"> & { id: string }>;
}
