import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { format, addDays, subDays, startOfToday, parseISO } from 'date-fns';
import { it } from 'date-fns/locale';
import { useDiaryStore } from '../../src/stores/diaryStore';
import { useGoalsStore } from '../../src/stores/goalsStore';
import DailySummaryCard from '../../src/components/DailySummaryCard';
import MealSection from '../../src/components/MealSection';
import type { MealType } from '../../src/types';

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Colazione',
  lunch: 'Pranzo',
  dinner: 'Cena',
  snack: 'Spuntino',
};

export default function Home() {
  const router = useRouter();
  const { selectedDate, entries, totals, loading, setDate, loadEntries, removeEntry } =
    useDiaryStore();
  const { goals, loadGoals } = useGoalsStore();

  const [refreshing, setRefreshing] = useState(false);

  // Load initial data
  useEffect(() => {
    loadGoals();
    loadEntries(selectedDate);
  }, []);

  // Reload entries when date changes
  useEffect(() => {
    loadEntries(selectedDate);
  }, [selectedDate]);

  const handlePreviousDay = () => {
    const currentDate = parseISO(selectedDate);
    const previousDay = subDays(currentDate, 1);
    setDate(format(previousDay, 'yyyy-MM-dd'));
  };

  const handleNextDay = () => {
    const currentDate = parseISO(selectedDate);
    const nextDay = addDays(currentDate, 1);
    setDate(format(nextDay, 'yyyy-MM-dd'));
  };

  const handleToday = () => {
    const today = startOfToday();
    setDate(format(today, 'yyyy-MM-dd'));
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadGoals(), loadEntries(selectedDate)]);
    setRefreshing(false);
  }, [selectedDate]);

  const handleAddFood = (mealType: MealType) => {
    router.push({
      pathname: '/search',
      params: { mealType },
    });
  };

  const handleDeleteEntry = async (entryId: number) => {
    try {
      await removeEntry(entryId);
    } catch (error) {
      console.error('Failed to delete entry:', error);
    }
  };

  const getEntriesByMealType = (mealType: MealType) => {
    return entries.filter((entry) => entry.meal_type === mealType);
  };

  // Format date display
  const displayDate = format(parseISO(selectedDate), 'EEE d MMM', { locale: it });
  const isToday = selectedDate === format(startOfToday(), 'yyyy-MM-dd');

  if (!goals) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4CAF50" />
        <Text style={styles.loadingText}>Caricamento...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#4CAF50"
            colors={['#4CAF50']}
          />
        }
      >
        {/* Date Selector */}
        <View style={styles.dateSelector}>
          <Pressable
            style={({ pressed }) => [
              styles.dateArrow,
              pressed && styles.dateArrowPressed,
            ]}
            onPress={handlePreviousDay}
          >
            <Text style={styles.arrowText}>‹</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.dateCenter,
              pressed && styles.dateCenterPressed,
            ]}
            onPress={handleToday}
          >
            <Text style={[styles.dateText, isToday && styles.todayText]}>
              {isToday ? 'Oggi' : displayDate}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.dateArrow,
              pressed && styles.dateArrowPressed,
            ]}
            onPress={handleNextDay}
          >
            <Text style={styles.arrowText}>›</Text>
          </Pressable>
        </View>

        {/* Daily Summary */}
        <View style={styles.summaryContainer}>
          <DailySummaryCard totals={totals} goals={goals} />
        </View>

        {/* Meal Sections */}
        <View style={styles.mealsContainer}>
          {(['breakfast', 'lunch', 'dinner', 'snack'] as MealType[]).map((mealType) => (
            <MealSection
              key={mealType}
              mealType={mealType}
              entries={getEntriesByMealType(mealType)}
              onAddPress={() => handleAddFood(mealType)}
              onDeleteEntry={handleDeleteEntry}
            />
          ))}
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
    paddingBottom: 24,
  },
  dateSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E0E0E0',
  },
  dateArrow: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F5F5F5',
  },
  dateArrowPressed: {
    backgroundColor: '#E0E0E0',
  },
  arrowText: {
    fontSize: 32,
    fontWeight: '300',
    color: '#4CAF50',
  },
  dateCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#FAFAFA',
  },
  dateCenterPressed: {
    backgroundColor: '#F0F0F0',
  },
  dateText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#212121',
    textTransform: 'capitalize',
  },
  todayText: {
    color: '#4CAF50',
  },
  summaryContainer: {
    paddingHorizontal: 16,
  },
  mealsContainer: {
    paddingTop: 8,
  },
});
