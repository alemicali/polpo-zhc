import { useState, useEffect, useCallback } from "react";
import { usePolpo } from "./use-polpo.js";
import type {
  TemplateInfo,
  TemplateDefinition,
  TemplateRunResult,
} from "@lumea-labs/polpo-client";

export interface UseTemplatesReturn {
  /** List of discovered templates (lightweight metadata). */
  templates: TemplateInfo[];
  /** Loading state for the template list. */
  loading: boolean;
  /** Refresh the template list from the server. */
  refetch: () => void;
  /** Get the full definition (including mission template) for a template. */
  getTemplate: (name: string) => Promise<TemplateDefinition>;
  /** Run a template with parameters. */
  runTemplate: (
    name: string,
    params?: Record<string, string | number | boolean>,
  ) => Promise<TemplateRunResult>;
}

/**
 * Hook for listing, inspecting, and running templates.
 *
 * Templates are parameterized mission templates discovered from disk.
 * Running a template instantiates a Mission and executes it.
 */
export function useTemplates(): UseTemplatesReturn {
  const { client } = usePolpo();
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    if (!client) return;
    setLoading(true);
    client
      .getTemplates()
      .then(setTemplates)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [client]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const getTemplate = useCallback(
    async (name: string) => {
      if (!client) throw new Error("Client not initialized");
      return client.getTemplate(name);
    },
    [client],
  );

  const runTemplate = useCallback(
    async (
      name: string,
      params?: Record<string, string | number | boolean>,
    ) => {
      if (!client) throw new Error("Client not initialized");
      const result = await client.runTemplate(name, params);
      // Refetch templates list in case discovery changed
      refetch();
      return result;
    },
    [client, refetch],
  );

  return { templates, loading, refetch, getTemplate, runTemplate };
}
