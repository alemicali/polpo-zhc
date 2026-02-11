import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { Pencil } from 'lucide-react-native';
import { useGoalsStore } from '../src/stores/goalsStore';
import { getWeeklyStats, calculateAverageCalories, formatDateItalian } from '../src/utils/stats';
import type { DailyStats } from '../src/utils/stats';
import { getDatabase, closeDatabase } from '../src/database/db';

export default function Profile() {
  const { goals, loading, loadGoals, updateGoals } = useGoalsStore();
  const [weeklyStats, setWeeklyStats] = useState<DailyStats[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);

  // Editable goal values
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({
    calories: '',
    protein: '',
    carbs: '',
    fat: '',
  });

  useEffect(() => {
    loadGoals();
    loadWeeklyStats();
  }, []);

  useEffect(() => {
    if (goals) {
      setEditValues({
        calories: goals.calories.toString(),
        protein: goals.protein.toString(),
        carbs: goals.carbs.toString(),
        fat: goals.fat.toString(),
      });
    }
  }, [goals]);

  const loadWeeklyStats = async () => {
    setStatsLoading(true);
    try {
      const stats = await getWeeklyStats(new Date(), 7);
      setWeeklyStats(stats);
    } catch (error) {
      console.error('Error loading weekly stats:', error);
    } finally {
      setStatsLoading(false);
    }
  };

  const handleSaveGoal = async (field: keyof typeof editValues) => {
    const value = parseFloat(editValues[field]);

    if (isNaN(value) || value < 0) {
      Alert.alert('Errore', 'Inserisci un valore valido');
      return;
    }

    try {
      await updateGoals({ [field]: value });
      setEditingField(null);
      Alert.alert('Successo', 'Obiettivo aggiornato');
    } catch (error) {
      Alert.alert('Errore', 'Impossibile salvare l\'obiettivo');
    }
  };

  const handleResetDatabase = () => {
    Alert.alert(
      'Resetta Database',
      'Sei sicuro di voler eliminare tutti i dati? Questa azione non può essere annullata.',
      [
        { text: 'Annulla', style: 'cancel' },
        {
          text: 'Resetta',
          style: 'destructive',
          onPress: async () => {
            try {
              await closeDatabase();
              Alert.alert('Successo', 'Database resettato. Riavvia l\'app.');
            } catch (error) {
              Alert.alert('Errore', 'Impossibile resettare il database');
            }
          },
        },
      ]
    );
  };

  const averageCalories = calculateAverageCalories(weeklyStats);

  const renderGoalField = (
    label: string,
    field: keyof typeof editValues,
    unit: string
  ) => {
    const isEditing = editingField === field;
    const currentValue = goals?.[field] ?? 0;

    return (
      <View style={styles.goalRow}>
        <Text style={styles.goalLabel}>{label}</Text>
        {isEditing ? (
          <View style={styles.editContainer}>
            <TextInput
              style={styles.input}
              value={editValues[field]}
              onChangeText={(text) =>
                setEditValues({ ...editValues, [field]: text })
              }
              keyboardType="numeric"
              autoFocus
            />
            <TouchableOpacity
              style={styles.saveButton}
              onPress={() => handleSaveGoal(field)}
            >
              <Text style={styles.saveButtonText}>Salva</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.cancelButton}
              onPress={() => {
                setEditingField(null);
                setEditValues({
                  ...editValues,
                  [field]: currentValue.toString(),
                });
              }}
            >
              <Text style={styles.cancelButtonText}>×</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.valueContainer}
            onPress={() => setEditingField(field)}
          >
            <Text style={styles.goalValue}>
              {currentValue} {unit}
            </Text>
            <Pencil size={18} color="#4CAF50" />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Daily Goals Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Obiettivi Giornalieri</Text>
        {loading ? (
          <Text style={styles.loadingText}>Caricamento...</Text>
        ) : (
          <>
            {renderGoalField('Calorie', 'calories', 'kcal')}
            {renderGoalField('Proteine', 'protein', 'g')}
            {renderGoalField('Carboidrati', 'carbs', 'g')}
            {renderGoalField('Grassi', 'fat', 'g')}
          </>
        )}
      </View>

      {/* Weekly Stats Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Statistiche Settimana</Text>
        {statsLoading ? (
          <Text style={styles.loadingText}>Caricamento...</Text>
        ) : (
          <>
            <View style={styles.averageContainer}>
              <Text style={styles.averageLabel}>Media giornaliera</Text>
              <Text style={styles.averageValue}>
                {averageCalories} kcal
              </Text>
            </View>

            <View style={styles.statsContainer}>
              {weeklyStats.map((day) => {
                const percentage = goals
                  ? Math.min((day.calories / goals.calories) * 100, 100)
                  : 0;

                return (
                  <View key={day.date} style={styles.dayRow}>
                    <Text style={styles.dayLabel}>
                      {formatDateItalian(day.date)}
                    </Text>
                    <View style={styles.barContainer}>
                      <View
                        style={[
                          styles.barFill,
                          {
                            width: `${percentage}%`,
                            backgroundColor:
                              percentage >= 90 ? '#4CAF50' : '#81C784',
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.dayValue}>
                      {Math.round(day.calories)}
                    </Text>
                  </View>
                );
              })}
            </View>
          </>
        )}
      </View>

      {/* Info Card */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Info</Text>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Versione App</Text>
          <Text style={styles.infoValue}>1.0.0</Text>
        </View>

        <TouchableOpacity
          style={styles.dangerButton}
          onPress={handleResetDatabase}
        >
          <Text style={styles.dangerButtonText}>Resetta Database</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#333',
    marginBottom: 16,
  },
  loadingText: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    paddingVertical: 16,
  },
  goalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  goalLabel: {
    fontSize: 16,
    color: '#555',
    fontWeight: '500',
  },
  valueContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  goalValue: {
    fontSize: 16,
    color: '#333',
    fontWeight: '600',
  },
  editContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#4CAF50',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 16,
    minWidth: 80,
    backgroundColor: '#fff',
  },
  saveButton: {
    backgroundColor: '#4CAF50',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  saveButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  cancelButton: {
    padding: 8,
  },
  cancelButtonText: {
    fontSize: 24,
    color: '#999',
    fontWeight: '300',
  },
  averageContainer: {
    backgroundColor: '#E8F5E9',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  averageLabel: {
    fontSize: 15,
    color: '#2E7D32',
    fontWeight: '500',
  },
  averageValue: {
    fontSize: 18,
    color: '#1B5E20',
    fontWeight: '700',
  },
  statsContainer: {
    gap: 12,
  },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dayLabel: {
    fontSize: 14,
    color: '#666',
    width: 50,
    fontWeight: '500',
  },
  barContainer: {
    flex: 1,
    height: 24,
    backgroundColor: '#f0f0f0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
  },
  dayValue: {
    fontSize: 14,
    color: '#333',
    fontWeight: '600',
    width: 50,
    textAlign: 'right',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  infoLabel: {
    fontSize: 16,
    color: '#555',
    fontWeight: '500',
  },
  infoValue: {
    fontSize: 16,
    color: '#333',
    fontWeight: '600',
  },
  dangerButton: {
    marginTop: 16,
    backgroundColor: '#ffebee',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#ef5350',
  },
  dangerButtonText: {
    color: '#c62828',
    fontWeight: '600',
    fontSize: 14,
    textAlign: 'center',
  },
});
