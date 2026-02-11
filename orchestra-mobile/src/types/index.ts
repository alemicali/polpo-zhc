/**
 * Type definitions for Polpo Mobile
 */

export type ConnectionStatus = 'connected' | 'disconnected';

export type Theme = 'light' | 'dark' | 'system';

export interface AppState {
  connectionStatus: ConnectionStatus;
  activeTasks: string[];
}

export interface OrchestraSettings {
  serverUrl: string;
  apiKey: string;
  theme: Theme;
  refreshInterval: number; // in seconds
  notificationsEnabled: boolean;
}

export type RootTabParamList = {
  Home: undefined;
  Tasks: undefined;
  Plans: undefined;
  Settings: undefined;
};
