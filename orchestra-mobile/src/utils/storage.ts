/**
 * Storage utility for persisting app settings using AsyncStorage
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { OrchestraSettings } from '../types';

const STORAGE_KEYS = {
  SETTINGS: '@orchestra:settings',
} as const;

export const DEFAULT_SETTINGS: OrchestraSettings = {
  serverUrl: '',
  apiKey: '',
  theme: 'system',
  refreshInterval: 5, // 5 seconds
  notificationsEnabled: true,
};

/**
 * Save Polpo settings to AsyncStorage
 */
export async function saveSettings(settings: OrchestraSettings): Promise<void> {
  try {
    const jsonValue = JSON.stringify(settings);
    await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, jsonValue);
  } catch (error) {
    console.error('Error saving settings:', error);
    throw new Error('Failed to save settings');
  }
}

/**
 * Load Polpo settings from AsyncStorage
 * Returns default settings if not found
 */
export async function loadSettings(): Promise<OrchestraSettings> {
  try {
    const jsonValue = await AsyncStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (jsonValue === null) {
      return DEFAULT_SETTINGS;
    }
    return JSON.parse(jsonValue) as OrchestraSettings;
  } catch (error) {
    console.error('Error loading settings:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Clear all stored settings
 */
export async function clearSettings(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEYS.SETTINGS);
  } catch (error) {
    console.error('Error clearing settings:', error);
    throw new Error('Failed to clear settings');
  }
}

/**
 * Test connection to Polpo server
 */
export async function testConnection(serverUrl: string, apiKey: string): Promise<boolean> {
  try {
    // Validate URL format
    if (!serverUrl || !serverUrl.startsWith('http')) {
      throw new Error('Invalid server URL');
    }

    // Remove trailing slash
    const cleanUrl = serverUrl.replace(/\/$/, '');

    // Try to fetch from the server
    const response = await fetch(`${cleanUrl}/api/v1/projects`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'X-API-Key': apiKey } : {}),
      },
      // Timeout after 5 seconds
      signal: AbortSignal.timeout(5000),
    });

    return response.ok;
  } catch (error) {
    console.error('Connection test failed:', error);
    return false;
  }
}
