/**
 * Polpo Mobile - Main Hook
 * Manages connection settings, API client, SSE events, and state synchronization
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OrchestraClient } from '../api/orchestra-client';
import { EventSourceManager, getConnectionStatusLabel } from '../api/event-source';
import type {
  Task,
  Plan,
  AgentConfig,
  AgentProcess,
  ConnectionStatus,
  SSEEvent,
  OrchestraState,
} from '../api/types';

const STORAGE_KEYS = {
  BASE_URL: '@orchestra/baseUrl',
  PROJECT_ID: '@orchestra/projectId',
  API_KEY: '@orchestra/apiKey',
};

export interface OrchestraSettings {
  baseUrl: string;
  projectId: string;
  apiKey?: string;
}

export interface OrchestraHookState {
  // Connection
  connectionStatus: ConnectionStatus;
  connectionStatusLabel: string;
  isConnected: boolean;

  // Settings
  settings: OrchestraSettings | null;
  settingsLoaded: boolean;

  // Data
  tasks: Task[];
  plans: Plan[];
  agents: AgentConfig[];
  processes: AgentProcess[];

  // Loading states
  loading: boolean;
  error: string | null;

  // Client
  client: OrchestraClient | null;
}

export interface OrchestraHookActions {
  // Settings
  updateSettings: (settings: OrchestraSettings) => Promise<void>;
  clearSettings: () => Promise<void>;

  // Connection
  connect: () => void;
  disconnect: () => void;

  // Data refresh
  refreshTasks: () => Promise<void>;
  refreshPlans: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshProcesses: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

export type UseOrchestraReturn = OrchestraHookState & OrchestraHookActions;

/**
 * Main Polpo hook - manages everything
 */
export function useOrchestra(): UseOrchestraReturn {
  const [settings, setSettings] = useState<OrchestraSettings | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [processes, setProcesses] = useState<AgentProcess[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<OrchestraClient | null>(null);
  const eventSourceRef = useRef<EventSourceManager | null>(null);

  // Load settings from AsyncStorage on mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const [baseUrl, projectId, apiKey] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.BASE_URL),
        AsyncStorage.getItem(STORAGE_KEYS.PROJECT_ID),
        AsyncStorage.getItem(STORAGE_KEYS.API_KEY),
      ]);

      if (baseUrl && projectId) {
        setSettings({
          baseUrl,
          projectId,
          apiKey: apiKey || undefined,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setSettingsLoaded(true);
    }
  };

  const updateSettings = useCallback(
    async (newSettings: OrchestraSettings) => {
      try {
        await Promise.all([
          AsyncStorage.setItem(STORAGE_KEYS.BASE_URL, newSettings.baseUrl),
          AsyncStorage.setItem(STORAGE_KEYS.PROJECT_ID, newSettings.projectId),
          newSettings.apiKey
            ? AsyncStorage.setItem(STORAGE_KEYS.API_KEY, newSettings.apiKey)
            : AsyncStorage.removeItem(STORAGE_KEYS.API_KEY),
        ]);
        setSettings(newSettings);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save settings');
      }
    },
    []
  );

  const clearSettings = useCallback(async () => {
    try {
      await Promise.all([
        AsyncStorage.removeItem(STORAGE_KEYS.BASE_URL),
        AsyncStorage.removeItem(STORAGE_KEYS.PROJECT_ID),
        AsyncStorage.removeItem(STORAGE_KEYS.API_KEY),
      ]);
      setSettings(null);
      disconnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear settings');
    }
  }, []);

  // Initialize client when settings change
  useEffect(() => {
    if (settings) {
      clientRef.current = new OrchestraClient(settings);
    } else {
      clientRef.current = null;
    }
  }, [settings]);

  /**
   * Event handler for SSE events
   * Keeps local state synchronized with server events in real-time
   * Uses immutable updates to trigger React re-renders
   */
  const handleEvent = useCallback((event: SSEEvent) => {
    // Update state based on event type
    switch (event.event) {
      case 'task:created':
      case 'task:transition':
      case 'task:updated':
        // Upsert task: update if exists, append if new
        setTasks((prev) => {
          const task = event.data as Task;
          const index = prev.findIndex((t) => t.id === task.id);
          if (index >= 0) {
            // Update existing task
            const updated = [...prev];
            updated[index] = task;
            return updated;
          }
          // Add new task
          return [...prev, task];
        });
        break;

      case 'task:removed':
        // Remove task from list
        setTasks((prev) =>
          prev.filter((t) => t.id !== (event.data as { taskId: string }).taskId)
        );
        break;

      case 'plan:saved':
      case 'plan:executed':
      case 'plan:completed':
      case 'plan:resumed':
        // Upsert plan: update if exists, append if new
        setPlans((prev) => {
          const plan = event.data as Plan;
          const index = prev.findIndex((p) => p.id === plan.id);
          if (index >= 0) {
            // Update existing plan
            const updated = [...prev];
            updated[index] = plan;
            return updated;
          }
          // Add new plan
          return [...prev, plan];
        });
        break;

      case 'plan:deleted':
        // Remove plan from list
        setPlans((prev) =>
          prev.filter((p) => p.id !== (event.data as { planId: string }).planId)
        );
        break;

      case 'agent:spawned':
        // New agent process started - fetch updated process list
        refreshProcesses();
        break;

      case 'agent:finished':
        // Agent completed - remove from active processes
        setProcesses((prev) =>
          prev.filter(
            (p) => p.taskId !== (event.data as { taskId: string }).taskId
          )
        );
        break;
    }
  }, []);

  const handleStatusChange = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status);
  }, []);

  /**
   * Establish SSE connection to Polpo server
   * - Disconnects any existing connection first
   * - Creates EventSourceManager with auto-reconnect
   * - Fetches initial data snapshot via REST API
   */
  const connect = useCallback(() => {
    if (!settings || !clientRef.current) {
      setError('No settings configured');
      return;
    }

    // Disconnect existing connection to avoid duplicates
    if (eventSourceRef.current) {
      eventSourceRef.current.disconnect();
    }

    // Build SSE URL with project ID
    const url = clientRef.current.getEventsUrl();
    const apiKey = clientRef.current.getApiKey();

    // Create EventSourceManager with exponential backoff reconnection
    eventSourceRef.current = new EventSourceManager({
      url,
      apiKey,
      onEvent: handleEvent,
      onStatusChange: handleStatusChange,
      reconnectDelay: 1000,        // Start at 1s
      maxReconnectDelay: 30000,    // Max 30s between retries
    });

    eventSourceRef.current.connect();

    // Initial data fetch via REST API (SSE only sends updates)
    refreshAll();
  }, [settings, handleEvent, handleStatusChange]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.disconnect();
      eventSourceRef.current = null;
    }
    setConnectionStatus('disconnected');
  }, []);

  // Data refresh methods
  const refreshTasks = useCallback(async () => {
    if (!clientRef.current) return;
    try {
      setLoading(true);
      const data = await clientRef.current.getTasks();
      setTasks(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPlans = useCallback(async () => {
    if (!clientRef.current) return;
    try {
      setLoading(true);
      const data = await clientRef.current.getPlans();
      setPlans(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch plans');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    if (!clientRef.current) return;
    try {
      setLoading(true);
      const data = await clientRef.current.getAgents();
      setAgents(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agents');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshProcesses = useCallback(async () => {
    if (!clientRef.current) return;
    try {
      const data = await clientRef.current.getProcesses();
      setProcesses(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch processes');
    }
  }, []);

  const refreshAll = useCallback(async () => {
    if (!clientRef.current) return;
    setLoading(true);
    await Promise.all([
      refreshTasks(),
      refreshPlans(),
      refreshAgents(),
      refreshProcesses(),
    ]);
    setLoading(false);
  }, [refreshTasks, refreshPlans, refreshAgents, refreshProcesses]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    // Connection
    connectionStatus,
    connectionStatusLabel: getConnectionStatusLabel(connectionStatus),
    isConnected: connectionStatus === 'connected',

    // Settings
    settings,
    settingsLoaded,

    // Data
    tasks,
    plans,
    agents,
    processes,

    // Loading
    loading,
    error,

    // Client
    client: clientRef.current,

    // Actions
    updateSettings,
    clearSettings,
    connect,
    disconnect,
    refreshTasks,
    refreshPlans,
    refreshAgents,
    refreshProcesses,
    refreshAll,
  };
}
