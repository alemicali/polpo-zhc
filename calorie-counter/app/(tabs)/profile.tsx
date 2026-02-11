import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Pencil, RotateCcw, Trash2 } from 'lucide-react-native';
import { useGoalsStore } from '../../src/stores/goalsStore';
import { getWeeklyStats, calculateAverageCalories, formatDateItalian } from '../../src/utils/stats';
import * as diaryRepo from '../../src/database/repositories/diaryRepository';
import type { DailyStats } from '../../src/utils/stats';
import type { DailyGoals } from '../../src/types';

export default function Profile() {
  const { goals, loading: goalsLoading, loadGoals, updateGoals, resetToDefaults } = useGoalsStore();
  const [weeklyStats, setWeeklyStats] = useState<DailyStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [editingGoals, setEditingGoals] = useState<Partial<DailyGoals>>({});
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load goals and weekly stats on mount
  useEffect(() => {
    loadGoals();
    loadWeeklyStats();
  }, []);

  // Initialize editing state when goals are loaded
  useEffect(() => {
    if (goals && !isEditing) {
      setEditingGoals({
        calories: goals.calories,
        protein: goals.protein,
        carbs: goals.carbs,
        fat: goals.fat,
      });
    }
  }, [goals]);

  const loadWeeklyStats = async () => {
    setStatsLoading(true);
    try {
      const stats = await getWeeklyStats(new Date());
      setWeeklyStats(stats);
    } catch (error) {
      console.error('Failed to load weekly stats:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleSaveGoals = async () => {
    if (!editingGoals.calories || !editingGoals.protein || !editingGoals.carbs || !editingGoals.fat) {
      Alert.alert('Errore', 'Tutti i campi sono obbligatori');
      return;
    }

    if (
      editingGoals.calories <= 0 ||
      editingGoals.protein <= 0 ||
      editingGoals.carbs <= 0 ||
      editingGoals.fat <= 0
    ) {
      Alert.alert('Errore', 'Tutti i valori devono essere maggiori di zero');
      return;
    }

    setSaving(true);
    try {
      await updateGoals(editingGoals);
      setIsEditing(false);
      Alert.alert('Successo', 'Obiettivi salvati con successo');
    } catch (error) {
      console.error('Failed to save goals:', error);
      Alert.alert('Errore', 'Impossibile salvare gli obiettivi');
    } finally {
      setSaving(false);
    }
  };

  const handleResetGoals = () => {
    Alert.alert(
      'Resetta Obiettivi',
      'Sei sicuro di voler ripristinare gli obiettivi ai valori predefiniti?',
      [
        {
          text: 'Annulla',
          style: 'cancel',
        },
        {
          text: 'Conferma',
          style: 'destructive',
          onPress: async () => {
            try {
              await resetToDefaults();
              Alert.alert('Successo', 'Obiettivi ripristinati ai valori predefiniti');
            } catch (error) {
              console.error('Failed to reset goals:', error);
              Alert.alert('Errore', 'Impossibile ripristinare gli obiettivi');
            }
          },
        },
      ]
    );
  };

  const handleClearData = () => {
    Alert.alert(
      'Cancella Dati',
      'Sei sicuro di voler cancellare tutti i dati del diario? Questa operazione non può essere annullata.',
      [
        {
          text: 'Annulla',
          style: 'cancel',
        },
        {
          text: 'Conferma',
          style: 'destructive',
          onPress: async () => {
            try {
              await diaryRepo.clearAllEntries();
              await loadWeeklyStats();
              Alert.alert('Successo', 'Dati del diario cancellati con successo');
            } catch (error) {
              console.error('Failed to clear data:', error);
              Alert.alert('Errore', 'Impossibile cancellare i dati');
            }
          },
        },
      ]
    );
  };

  const renderGoalField = (
    label: string,
    field: keyof Pick<DailyGoals, 'calories' | 'protein' | 'carbs' | 'fat'>,
    unit: string
  ) => {
    return (
      <View style={styles.goalField}>
        <Text style={styles.goalLabel}>{label}</Text>
        <View style={styles.goalInputContainer}>
          <TextInput
            style={[styles.goalInput, !isEditing && styles.goalInputDisabled]}
            value={editingGoals[field]?.toString() || ''}
            onChangeText={(text) => {
              const value = parseInt(text, 10);
              setEditingGoals({ ...editingGoals, [field]: isNaN(value) ? 0 : value });
            }}
            keyboardType="numeric"
            editable={isEditing}
            placeholder="0"
          />
          <Text style={styles.goalUnit}>{unit}</Text>
          {!isEditing && (
            <Pressable
              style={styles.editIconButton}
              onPress={() => setIsEditing(true)}
            >
              <Pencil size={20} color="#757575" />
            </Pressable>
          )}
        </View>
      </View>
    );
  };

  const renderWeeklyStatsBar = (day: DailyStats) => {
    if (!goals) return null;

    const percentage = goals.calories > 0 ? (day.calories / goals.calories) * 100 : 0;
    const barHeight = Math.min(percentage, 100);
    const isOverGoal = percentage > 100;

    return (
      <View key={day.date} style={styles.statBar}>
        <View style={styles.statBarContainer}>
          <View
            style={[
              styles.statBarFill,
              { height: `${barHeight}%` },
              isOverGoal ? styles.statBarOver : styles.statBarNormal,
            ]}
          />
        </View>
        <Text style={styles.statBarLabel}>{formatDateItalian(day.date)}</Text>
        <Text style={styles.statBarValue}>{Math.round(day.calories)}</Text>
      </View>
    );
  };

  if (goalsLoading || !goals) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4CAF50" />
        <Text style={styles.loadingText}>Caricamento...</Text>
      </View>
    );
  }

  const averageCalories = calculateAverageCalories(weeklyStats);

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Daily Goals Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Obiettivi Giornalieri</Text>
          <View style={styles.cardContent}>
            {renderGoalField('Calorie', 'calories', 'kcal')}
            {renderGoalField('Proteine', 'protein', 'g')}
            {renderGoalField('Carboidrati', 'carbs', 'g')}
            {renderGoalField('Grassi', 'fat', 'g')}

            {isEditing && (
              <View style={styles.buttonRow}>
                <Pressable
                  style={[styles.button, styles.cancelButton]}
                  onPress={() => {
                    setIsEditing(false);
                    setEditingGoals({
                      calories: goals.calories,
                      protein: goals.protein,
                      carbs: goals.carbs,
                      fat: goals.fat,
                    });
                  }}
                >
                  <Text style={styles.cancelButtonText}>Annulla</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.saveButton, saving && styles.buttonDisabled]}
                  onPress={handleSaveGoals}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#FFF" />
                  ) : (
                    <Text style={styles.saveButtonText}>Salva</Text>
                  )}
                </Pressable>
              </View>
            )}
          </View>
        </View>

        {/* Weekly Stats Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Statistiche Settimanali</Text>
          <View style={styles.cardContent}>
            {statsLoading ? (
              <ActivityIndicator size="small" color="#4CAF50" />
            ) : (
              <>
                <View style={styles.statsHeader}>
                  <Text style={styles.statsHeaderText}>
                    Media Giornaliera: <Text style={styles.statsHeaderValue}>{averageCalories} kcal</Text>
                  </Text>
                  <Text style={styles.statsHeaderSubtext}>
                    Obiettivo: {goals.calories} kcal
                  </Text>
                </View>
                <View style={styles.statsChart}>
                  {weeklyStats.map((day) => renderWeeklyStatsBar(day))}
                </View>
                <View style={styles.statsLegend}>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendColor, styles.statBarNormal]} />
                    <Text style={styles.legendText}>Sotto obiettivo</Text>
                  </View>
                  <View style={styles.legendItem}>
                    <View style={[styles.legendColor, styles.statBarOver]} />
                    <Text style={styles.legendText}>Sopra obiettivo</Text>
                  </View>
                </View>
              </>
            )}
          </View>
        </View>

        {/* Settings Section */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Impostazioni</Text>
          <View style={styles.cardContent}>
            <Pressable
              style={({ pressed }) => [
                styles.settingsButton,
                pressed && styles.settingsButtonPressed,
              ]}
              onPress={handleResetGoals}
            >
              <View style={styles.settingsButtonContent}>
                <RotateCcw size={20} color="#1976D2" />
                <Text style={styles.settingsButtonText}>Resetta Obiettivi</Text>
              </View>
            </Pressable>
            <View style={styles.buttonSpacer} />
            <Pressable
              style={({ pressed }) => [
                styles.dangerButton,
                pressed && styles.dangerButtonPressed,
              ]}
              onPress={handleClearData}
            >
              <View style={styles.dangerButtonContent}>
                <Trash2 size={20} color="#D32F2F" />
                <Text style={styles.dangerButtonText}>Cancella Dati</Text>
              </View>
            </Pressable>
          </View>
        </View>

        {/* App Info */}
        <View style={styles.card}>
          <View style={styles.cardContent}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Versione App</Text>
              <Text style={styles.infoValue}>1.0.0</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5F5F5',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: '#757575',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#212121',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  cardContent: {
    padding: 16,
  },
  goalField: {
    marginBottom: 16,
  },
  goalLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#616161',
    marginBottom: 8,
  },
  goalInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F5F5F5',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  goalInput: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: '#212121',
    padding: 8,
  },
  goalInputDisabled: {
    color: '#757575',
  },
  goalUnit: {
    fontSize: 14,
    color: '#9E9E9E',
    marginLeft: 8,
    marginRight: 8,
  },
  editIconButton: {
    padding: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButton: {
    backgroundColor: '#4CAF50',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    backgroundColor: '#E0E0E0',
  },
  cancelButtonText: {
    color: '#616161',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  statsHeader: {
    marginBottom: 16,
    alignItems: 'center',
  },
  statsHeaderText: {
    fontSize: 16,
    color: '#616161',
    marginBottom: 4,
  },
  statsHeaderValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#4CAF50',
  },
  statsHeaderSubtext: {
    fontSize: 14,
    color: '#9E9E9E',
  },
  statsChart: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    height: 180,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  statBar: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  statBarContainer: {
    flex: 1,
    width: '80%',
    backgroundColor: '#F5F5F5',
    borderRadius: 4,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  statBarFill: {
    width: '100%',
    borderRadius: 4,
  },
  statBarNormal: {
    backgroundColor: '#4CAF50',
  },
  statBarOver: {
    backgroundColor: '#FF9800',
  },
  statBarLabel: {
    fontSize: 10,
    color: '#9E9E9E',
    fontWeight: '500',
  },
  statBarValue: {
    fontSize: 11,
    color: '#616161',
    fontWeight: '600',
  },
  statsLegend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginTop: 16,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  legendColor: {
    width: 16,
    height: 16,
    borderRadius: 4,
  },
  legendText: {
    fontSize: 12,
    color: '#616161',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  infoLabel: {
    fontSize: 16,
    color: '#616161',
  },
  infoValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#212121',
  },
  divider: {
    height: 1,
    backgroundColor: '#E0E0E0',
    marginVertical: 8,
  },
  settingsButton: {
    backgroundColor: '#E3F2FD',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#BBDEFB',
  },
  settingsButtonPressed: {
    backgroundColor: '#BBDEFB',
  },
  settingsButtonText: {
    color: '#1976D2',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonSpacer: {
    height: 12,
  },
  dangerButton: {
    backgroundColor: '#FFEBEE',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FFCDD2',
  },
  dangerButtonPressed: {
    backgroundColor: '#FFCDD2',
  },
  dangerButtonText: {
    color: '#D32F2F',
    fontSize: 16,
    fontWeight: '600',
  },
});
