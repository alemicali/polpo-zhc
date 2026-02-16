import { useState, useEffect, useCallback } from "react";
import { usePolpo } from "./use-polpo.js";
import type {
  WorkflowInfo,
  WorkflowDefinition,
  WorkflowRunResult,
} from "../client/types.js";

export interface UseWorkflowsReturn {
  /** List of discovered workflows (lightweight metadata). */
  workflows: WorkflowInfo[];
  /** Loading state for the workflow list. */
  loading: boolean;
  /** Refresh the workflow list from the server. */
  refetch: () => void;
  /** Get the full definition (including plan template) for a workflow. */
  getWorkflow: (name: string) => Promise<WorkflowDefinition>;
  /** Run a workflow with parameters. */
  runWorkflow: (
    name: string,
    params?: Record<string, string | number | boolean>,
  ) => Promise<WorkflowRunResult>;
}

/**
 * Hook for listing, inspecting, and running workflows.
 *
 * Workflows are parameterized plan templates discovered from disk.
 * Running a workflow instantiates a Plan and executes it.
 */
export function useWorkflows(): UseWorkflowsReturn {
  const { client } = usePolpo();
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    if (!client) return;
    setLoading(true);
    client
      .getWorkflows()
      .then(setWorkflows)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const getWorkflow = useCallback(
    async (name: string) => {
      if (!client) throw new Error("Client not initialized");
      return client.getWorkflow(name);
    },
    [client],
  );

  const runWorkflow = useCallback(
    async (
      name: string,
      params?: Record<string, string | number | boolean>,
    ) => {
      if (!client) throw new Error("Client not initialized");
      const result = await client.runWorkflow(name, params);
      // Refetch workflows list in case discovery changed
      refetch();
      return result;
    },
    [client, refetch],
  );

  return { workflows, loading, refetch, getWorkflow, runWorkflow };
}
