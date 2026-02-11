/**
 * Home Screen - Main dashboard for Polpo Mobile
 * Displays real-time connection status and active tasks from SSE
 */
import React, { useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  SafeAreaView,
  ScrollView,
  useWindowDimensions,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { ClipboardList, Wifi, WifiOff, RefreshCw } from 'lucide-react-native';
import { useOrchestra } from '../hooks/useOrchestra';

const COLORS = {
  background: '#f5f5f5',
  cardBackground: '#ffffff',
  primary: '#2196f3',
  textPrimary: '#1a1a1a',
  textSecondary: '#666',
  textTertiary: '#888',
  textQuaternary: '#999',
  border: '#e0e0e0',
  statusConnected: '#4caf50',
  statusDisconnected: '#f44336',
  statusReconnecting: '#ff9800',
  taskAccent: '#2196f3',
  emptyStateBg: '#f8f8f8',
  shadow: '#000',
} as const;

const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

const TYPOGRAPHY = {
  headerTitle: 32,
  welcomeTitle: 20,
  cardTitle: 18,
  statusText: 16,
  bodyText: 15,
  hint: 14,
  badge: 12,
} as const;

export default function HomeScreen(): React.JSX.Element {
  const { width } = useWindowDimensions();
  const isCompact = width < 768;

  // Polpo hook - manages connection and real-time data
  const {
    connectionStatus,
    connectionStatusLabel,
    isConnected,
    tasks,
    plans,
    settings,
    settingsLoaded,
    loading,
    error,
    connect,
    disconnect,
    updateSettings,
    refreshAll,
  } = useOrchestra();

  // Auto-connect if settings are available
  useEffect(() => {
    if (settingsLoaded && settings && connectionStatus === 'disconnected') {
      connect();
    }
  }, [settingsLoaded, settings, connectionStatus]);

  // For demo purposes, set default settings if not configured
  useEffect(() => {
    if (settingsLoaded && !settings) {
      // Default to localhost - user can change in settings later
      updateSettings({
        baseUrl: 'http://localhost:3000',
        projectId: 'default',
      });
    }
  }, [settingsLoaded, settings]);

  // Get active tasks (in_progress status)
  const activeTasks = tasks.filter((t) => t.status === 'in_progress');
  const completedTasks = tasks.filter((t) => t.status === 'done');
  const failedTasks = tasks.filter((t) => t.status === 'failed');

  // Get status indicator color
  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected':
        return COLORS.statusConnected;
      case 'connecting':
      case 'reconnecting':
        return COLORS.statusReconnecting;
      default:
        return COLORS.statusDisconnected;
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[
          styles.contentContainer,
          !isCompact && styles.contentContainerWide,
        ]}
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Polpo Mobile</Text>
          <Text style={styles.headerSubtitle}>OpenPolpo Companion</Text>
        </View>

        {/* Welcome Message */}
        <View style={styles.welcomeCard}>
          <Text style={styles.welcomeTitle}>Welcome to Polpo</Text>
          <Text style={styles.welcomeText}>
            Your mobile companion for orchestrating teams of AI coding agents.
            Monitor active tasks, track progress, and stay connected to your Polpo instance.
          </Text>
        </View>

        {/* Connection Status Card */}
        <View style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Connection Status</Text>
            {isConnected && (
              <TouchableOpacity
                onPress={refreshAll}
                style={styles.refreshButton}
                disabled={loading}
              >
                <RefreshCw
                  size={20}
                  color={COLORS.primary}
                  style={loading ? styles.spinning : undefined}
                />
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.statusRow}>
            <View
              style={[
                styles.statusIndicator,
                { backgroundColor: getStatusColor() },
              ]}
            />
            <Text style={styles.statusText}>{connectionStatusLabel}</Text>
            {connectionStatus === 'connecting' ||
            connectionStatus === 'reconnecting' ? (
              <ActivityIndicator
                size="small"
                color={COLORS.primary}
                style={styles.statusSpinner}
              />
            ) : null}
          </View>
          {settings && (
            <Text style={styles.statusHint}>
              {settings.baseUrl} / {settings.projectId}
            </Text>
          )}
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>

        {/* Stats Cards */}
        {isConnected && (
          <View style={styles.statsRow}>
            <View style={[styles.statCard, styles.statCardPrimary]}>
              <Text style={styles.statValue}>{tasks.length}</Text>
              <Text style={styles.statLabel}>Total Tasks</Text>
            </View>
            <View style={[styles.statCard, styles.statCardSuccess]}>
              <Text style={styles.statValue}>{activeTasks.length}</Text>
              <Text style={styles.statLabel}>Active</Text>
            </View>
            <View style={[styles.statCard, styles.statCardInfo]}>
              <Text style={styles.statValue}>{completedTasks.length}</Text>
              <Text style={styles.statLabel}>Done</Text>
            </View>
            <View style={[styles.statCard, styles.statCardDanger]}>
              <Text style={styles.statValue}>{failedTasks.length}</Text>
              <Text style={styles.statLabel}>Failed</Text>
            </View>
          </View>
        )}

        {/* Active Tasks */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>
            Active Tasks {activeTasks.length > 0 && `(${activeTasks.length})`}
          </Text>
          {!isConnected ? (
            <View style={styles.emptyState}>
              <WifiOff size={48} color={COLORS.textTertiary} />
              <Text style={styles.emptyStateText}>Not Connected</Text>
              <Text style={styles.emptyStateHint}>
                Connect to see your active tasks
              </Text>
            </View>
          ) : activeTasks.length === 0 ? (
            <View style={styles.emptyState}>
              <ClipboardList
                size={48}
                color={COLORS.textTertiary}
                style={styles.emptyStateIcon}
              />
              <Text style={styles.emptyStateText}>No active tasks</Text>
              <Text style={styles.emptyStateHint}>
                Tasks will appear here when agents start working
              </Text>
            </View>
          ) : (
            <View style={styles.taskList}>
              {activeTasks.map((task) => (
                <View key={task.id} style={styles.taskItem}>
                  <View style={styles.taskHeader}>
                    <Text style={styles.taskTitle}>{task.title}</Text>
                    <View style={styles.taskBadge}>
                      <Text style={styles.taskBadgeText}>
                        {task.status.replace('_', ' ')}
                      </Text>
                    </View>
                  </View>
                  {task.description && (
                    <Text style={styles.taskDescription} numberOfLines={2}>
                      {task.description}
                    </Text>
                  )}
                  {task.assignTo && (
                    <Text style={styles.taskAgent}>Agent: {task.assignTo}</Text>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Recent Plans */}
        {isConnected && plans.length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Recent Plans ({plans.length})</Text>
            <View style={styles.planList}>
              {plans.slice(0, 3).map((plan) => (
                <View key={plan.id} style={styles.planItem}>
                  <Text style={styles.planName}>{plan.name}</Text>
                  <View style={styles.planStats}>
                    <Text style={styles.planStat}>
                      {plan.tasks.length} tasks
                    </Text>
                    <View
                      style={[
                        styles.planBadge,
                        plan.status === 'completed' && styles.planBadgeSuccess,
                        plan.status === 'running' && styles.planBadgeActive,
                      ]}
                    >
                      <Text style={styles.planBadgeText}>{plan.status}</Text>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
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
  contentContainerWide: {
    maxWidth: 1200,
    alignSelf: 'center',
    width: '100%',
  },
  header: {
    paddingVertical: SPACING.xxl,
    paddingHorizontal: SPACING.sm,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: TYPOGRAPHY.headerTitle,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  headerSubtitle: {
    fontSize: SPACING.lg,
    color: COLORS.textSecondary,
    fontWeight: '500',
  },
  welcomeCard: {
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
  welcomeTitle: {
    fontSize: TYPOGRAPHY.welcomeTitle,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: SPACING.md,
  },
  welcomeText: {
    fontSize: TYPOGRAPHY.bodyText,
    lineHeight: 22,
    color: '#555',
  },
  card: {
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
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.lg,
  },
  cardTitle: {
    fontSize: TYPOGRAPHY.cardTitle,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
  },
  refreshButton: {
    padding: SPACING.sm,
  },
  spinning: {
    opacity: 0.5,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.sm,
  },
  statusIndicator: {
    width: SPACING.md,
    height: SPACING.md,
    borderRadius: 6,
    marginRight: 10,
  },
  statusConnected: {
    backgroundColor: COLORS.statusConnected,
  },
  statusDisconnected: {
    backgroundColor: COLORS.statusDisconnected,
  },
  statusText: {
    fontSize: TYPOGRAPHY.statusText,
    fontWeight: '600',
    color: COLORS.textPrimary,
  },
  statusHint: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textTertiary,
    marginTop: SPACING.xs,
  },
  statusSpinner: {
    marginLeft: SPACING.sm,
  },
  errorText: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.statusDisconnected,
    marginTop: SPACING.sm,
  },
  statsRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: SPACING.lg,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.cardBackground,
    borderRadius: SPACING.md,
    padding: SPACING.lg,
    alignItems: 'center',
    shadowColor: COLORS.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  statCardPrimary: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primary,
  },
  statCardSuccess: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.statusConnected,
  },
  statCardInfo: {
    borderLeftWidth: 3,
    borderLeftColor: '#2196f3',
  },
  statCardDanger: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.statusDisconnected,
  },
  statValue: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: SPACING.xs,
  },
  statLabel: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textSecondary,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: SPACING.xxxl,
  },
  emptyStateIcon: {
    marginBottom: SPACING.md,
  },
  emptyStateText: {
    fontSize: TYPOGRAPHY.statusText,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginBottom: SPACING.sm,
  },
  emptyStateHint: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textQuaternary,
    textAlign: 'center',
    paddingHorizontal: SPACING.xl,
  },
  taskList: {
    gap: SPACING.md,
  },
  taskItem: {
    padding: SPACING.lg,
    backgroundColor: COLORS.emptyStateBg,
    borderRadius: SPACING.sm,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.taskAccent,
  },
  taskText: {
    fontSize: TYPOGRAPHY.bodyText,
    color: '#333',
  },
  taskHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: SPACING.xs,
  },
  taskTitle: {
    flex: 1,
    fontSize: TYPOGRAPHY.bodyText,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginRight: SPACING.sm,
  },
  taskBadge: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: 4,
  },
  taskBadgeText: {
    fontSize: TYPOGRAPHY.badge,
    color: '#fff',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  taskDescription: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textSecondary,
    marginBottom: SPACING.xs,
  },
  taskAgent: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textTertiary,
    fontStyle: 'italic',
  },
  planList: {
    gap: SPACING.md,
  },
  planItem: {
    padding: SPACING.lg,
    backgroundColor: COLORS.emptyStateBg,
    borderRadius: SPACING.sm,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primary,
  },
  planName: {
    fontSize: TYPOGRAPHY.bodyText,
    fontWeight: '600',
    color: COLORS.textPrimary,
    marginBottom: SPACING.sm,
  },
  planStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  planStat: {
    fontSize: TYPOGRAPHY.hint,
    color: COLORS.textSecondary,
  },
  planBadge: {
    backgroundColor: COLORS.textTertiary,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: 4,
  },
  planBadgeSuccess: {
    backgroundColor: COLORS.statusConnected,
  },
  planBadgeActive: {
    backgroundColor: COLORS.primary,
  },
  planBadgeText: {
    fontSize: TYPOGRAPHY.badge,
    color: '#fff',
    fontWeight: '600',
    textTransform: 'capitalize',
  },
});
