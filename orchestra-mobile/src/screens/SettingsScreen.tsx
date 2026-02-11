/**
 * Settings Screen - Configure Polpo Mobile
 * Features:
 * - Polpo server connection settings (URL, project ID, API key)
 * - Test connection functionality
 * - Real-time connection status
 * - About section with app version
 * - Persistent storage using AsyncStorage
 */
import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Settings as SettingsIcon, Check, X, Info, Wifi } from 'lucide-react-native';
import { useOrchestra } from '../hooks/useOrchestra';
import { OrchestraClient } from '../api/orchestra-client';

const COLORS = {
  background: '#f5f5f5',
  cardBackground: '#ffffff',
  primary: '#2196f3',
  success: '#4caf50',
  error: '#f44336',
  textPrimary: '#1a1a1a',
  textSecondary: '#666',
  textTertiary: '#888',
  border: '#e0e0e0',
  inputBg: '#f8f8f8',
  shadow: '#000',
} as const;

const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

const TYPOGRAPHY = {
  headerTitle: 28,
  sectionTitle: 18,
  label: 14,
  input: 16,
  hint: 13,
  button: 16,
} as const;

export default function SettingsScreen(): React.JSX.Element {
  const {
    settings,
    settingsLoaded,
    connectionStatus,
    connectionStatusLabel,
    updateSettings,
    clearSettings,
    connect,
    disconnect,
  } = useOrchestra();

  const [localBaseUrl, setLocalBaseUrl] = useState('');
  const [localProjectId, setLocalProjectId] = useState('');
  const [localApiKey, setLocalApiKey] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<'success' | 'error' | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Load current settings into local state
  useEffect(() => {
    if (settings) {
      setLocalBaseUrl(settings.baseUrl);
      setLocalProjectId(settings.projectId);
      setLocalApiKey(settings.apiKey || '');
    }
  }, [settings]);

  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      // Validate server URL
      if (!localBaseUrl) {
        Alert.alert('Missing URL', 'Server URL is required');
        setIsSaving(false);
        return;
      }

      if (!localBaseUrl.startsWith('http')) {
        Alert.alert('Invalid URL', 'Server URL must start with http:// or https://');
        setIsSaving(false);
        return;
      }

      // Validate project ID
      if (!localProjectId) {
        Alert.alert('Missing Project ID', 'Project ID is required');
        setIsSaving(false);
        return;
      }

      await updateSettings({
        baseUrl: localBaseUrl,
        projectId: localProjectId,
        apiKey: localApiKey || undefined,
      });

      setHasUnsavedChanges(false);
      Alert.alert('Success', 'Settings saved successfully');

      // Reconnect with new settings
      disconnect();
      setTimeout(() => connect(), 500);
    } catch (error) {
      Alert.alert('Error', 'Failed to save settings. Please try again.');
      console.error('Error saving settings:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!localBaseUrl) {
      Alert.alert('Missing URL', 'Please enter a server URL first');
      return;
    }

    setIsTestingConnection(true);
    setConnectionTestResult(null);

    try {
      const health = await OrchestraClient.health(localBaseUrl);
      setConnectionTestResult('success');
      Alert.alert(
        'Success',
        `Connected to Polpo server v${health.version} successfully!`
      );
    } catch (error) {
      setConnectionTestResult('error');
      Alert.alert(
        'Connection Failed',
        'Could not connect to the Polpo server. Please check your URL.'
      );
      console.error('Connection test error:', error);
    } finally {
      setIsTestingConnection(false);
    }
  };

  const updateLocalSetting = (field: 'baseUrl' | 'projectId' | 'apiKey', value: string) => {
    if (field === 'baseUrl') setLocalBaseUrl(value);
    else if (field === 'projectId') setLocalProjectId(value);
    else setLocalApiKey(value);
    setHasUnsavedChanges(true);
    setConnectionTestResult(null);
  };

  if (!settingsLoaded) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text style={styles.loadingText}>Loading settings...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.contentContainer}>
        {/* Header */}
        <View style={styles.header}>
          <SettingsIcon size={32} color={COLORS.primary} />
          <Text style={styles.headerTitle}>Settings</Text>
        </View>

        {/* Current Connection Status */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connection Status</Text>
          <View style={styles.statusRow}>
            <Wifi
              size={24}
              color={
                connectionStatus === 'connected'
                  ? COLORS.success
                  : COLORS.error
              }
            />
            <View style={styles.statusInfo}>
              <Text style={styles.statusLabel}>Status:</Text>
              <Text
                style={[
                  styles.statusValue,
                  connectionStatus === 'connected' && styles.statusValueSuccess,
                ]}
              >
                {connectionStatusLabel}
              </Text>
            </View>
          </View>
        </View>

        {/* Server Connection Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Polpo Server</Text>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Server URL</Text>
            <TextInput
              style={styles.input}
              placeholder="http://localhost:3000"
              value={localBaseUrl}
              onChangeText={(text) => updateLocalSetting('baseUrl', text)}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <Text style={styles.hint}>
              Full URL including protocol (http:// or https://)
            </Text>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>Project ID</Text>
            <TextInput
              style={styles.input}
              placeholder="default"
              value={localProjectId}
              onChangeText={(text) => updateLocalSetting('projectId', text)}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.hint}>
              Project identifier from your Polpo instance
            </Text>
          </View>

          <View style={styles.inputGroup}>
            <Text style={styles.label}>API Key (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="Enter API key"
              value={localApiKey}
              onChangeText={(text) => updateLocalSetting('apiKey', text)}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={true}
            />
            <Text style={styles.hint}>
              Required if your server uses API key authentication
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.testButton,
              isTestingConnection && styles.testButtonDisabled,
              connectionTestResult === 'success' && styles.testButtonSuccess,
              connectionTestResult === 'error' && styles.testButtonError,
            ]}
            onPress={handleTestConnection}
            disabled={isTestingConnection}
          >
            {isTestingConnection ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : connectionTestResult === 'success' ? (
              <Check size={20} color="#fff" />
            ) : connectionTestResult === 'error' ? (
              <X size={20} color="#fff" />
            ) : null}
            <Text style={styles.testButtonText}>
              {isTestingConnection
                ? 'Testing...'
                : connectionTestResult === 'success'
                ? 'Connected'
                : connectionTestResult === 'error'
                ? 'Failed'
                : 'Test Connection'}
            </Text>
          </TouchableOpacity>
        </View>


        {/* About Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>

          <View style={styles.aboutRow}>
            <Info size={20} color={COLORS.textSecondary} />
            <View style={styles.aboutInfo}>
              <Text style={styles.aboutLabel}>App Version</Text>
              <Text style={styles.aboutValue}>1.0.0</Text>
            </View>
          </View>

          <View style={styles.aboutRow}>
            <Info size={20} color={COLORS.textSecondary} />
            <View style={styles.aboutInfo}>
              <Text style={styles.aboutLabel}>Polpo Mobile</Text>
              <Text style={styles.aboutValue}>Companion app for OpenPolpo orchestration framework</Text>
            </View>
          </View>
        </View>

        {/* Save Button */}
        {hasUnsavedChanges && (
          <TouchableOpacity
            style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
            onPress={handleSaveSettings}
            disabled={isSaving}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.saveButtonText}>Save Settings</Text>
            )}
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  scrollView: {
    flex: 1,
  },
  contentContainer: {
    padding: SPACING.lg,
    paddingBottom: SPACING.xxl,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: SPACING.lg,
    fontSize: TYPOGRAPHY.input,
    color: COLORS.textSecondary,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: SPACING.lg,
    gap: SPACING.md,
  },
  headerTitle: {
    fontSize: TYPOGRAPHY.headerTitle,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
  },
  section: {
    backgroundColor: COLORS.cardBackground,
    borderRadius: SPACING.md,
    padding: SPACING.xl,
    marginBottom: SPACING.lg,
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: TYPOGRAPHY.sectionTitle,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: SPACING.lg,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  statusInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  statusLabel: {
    fontSize: TYPOGRAPHY.input,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  statusValue: {
    fontSize: TYPOGRAPHY.input,
    color: COLORS.textSecondary,
  },
  statusValueSuccess: {
    color: COLORS.success,
  },
  inputGroup: {
    marginBottom: SPACING.lg,
  },
  label: {
    fontSize: TYPOGRAPHY.label,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  input: {
    backgroundColor: COLORS.inputBg,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: SPACING.sm,
    padding: SPACING.md,
    fontSize: TYPOGRAPHY.input,
    color: COLORS.textPrimary,
  },
  hint: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textTertiary,
    marginTop: SPACING.xs,
  },
  testButton: {
    backgroundColor: COLORS.primary,
    borderRadius: SPACING.sm,
    padding: SPACING.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  testButtonDisabled: {
    opacity: 0.6,
  },
  testButtonSuccess: {
    backgroundColor: COLORS.success,
  },
  testButtonError: {
    backgroundColor: COLORS.error,
  },
  testButtonText: {
    fontSize: TYPOGRAPHY.button,
    fontWeight: '600',
    color: '#fff',
  },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: SPACING.md,
    gap: SPACING.md,
  },
  aboutInfo: {
    flex: 1,
  },
  aboutLabel: {
    fontSize: TYPOGRAPHY.label,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  aboutValue: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textTertiary,
  },
  saveButton: {
    backgroundColor: COLORS.success,
    borderRadius: SPACING.sm,
    padding: SPACING.lg,
    alignItems: 'center',
    marginTop: SPACING.lg,
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 4,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonText: {
    fontSize: TYPOGRAPHY.button,
    fontWeight: 'bold',
    color: '#fff',
  },
});
