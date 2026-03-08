import { useState, useEffect, useCallback } from "react";
import { usePolpo } from "./use-polpo.js";
import type {
  PlaybookInfo,
  PlaybookDefinition,
  PlaybookRunResult,
} from "@polpo-ai/client";

export interface UsePlaybooksReturn {
  /** List of discovered playbooks (lightweight metadata). */
  playbooks: PlaybookInfo[];
  /** Loading state for the playbook list. */
  loading: boolean;
  /** Refresh the playbook list from the server. */
  refetch: () => void;
  /** Get the full definition (including mission body) for a playbook. */
  getPlaybook: (name: string) => Promise<PlaybookDefinition>;
  /** Run a playbook with parameters. */
  runPlaybook: (
    name: string,
    params?: Record<string, string | number | boolean>,
  ) => Promise<PlaybookRunResult>;

  // Backward-compat aliases
  /** @deprecated Use playbooks instead. */
  templates: PlaybookInfo[];
  /** @deprecated Use getPlaybook instead. */
  getTemplate: (name: string) => Promise<PlaybookDefinition>;
  /** @deprecated Use runPlaybook instead. */
  runTemplate: (
    name: string,
    params?: Record<string, string | number | boolean>,
  ) => Promise<PlaybookRunResult>;
}

/**
 * Hook for listing, inspecting, and running playbooks.
 *
 * Playbooks are parameterized mission definitions discovered from disk.
 * Running a playbook instantiates a Mission and executes it.
 */
export function usePlaybooks(): UsePlaybooksReturn {
  const { client } = usePolpo();
  const [playbooks, setPlaybooks] = useState<PlaybookInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    if (!client) return;
    setLoading(true);
    client
      .getPlaybooks()
      .then(setPlaybooks)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const getPlaybook = useCallback(
    async (name: string) => {
      if (!client) throw new Error("Client not initialized");
      return client.getPlaybook(name);
    },
    [client],
  );

  const runPlaybook = useCallback(
    async (
      name: string,
      params?: Record<string, string | number | boolean>,
    ) => {
      if (!client) throw new Error("Client not initialized");
      const result = await client.runPlaybook(name, params);
      // Refetch playbooks list in case discovery changed
      refetch();
      return result;
    },
    [client, refetch],
  );

  return {
    playbooks, loading, refetch, getPlaybook, runPlaybook,
    // Backward-compat aliases
    templates: playbooks,
    getTemplate: getPlaybook,
    runTemplate: runPlaybook,
  };
}

/** @deprecated Use usePlaybooks instead. */
export const useTemplates = usePlaybooks;
