import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MealType, DiaryEntryWithFood } from '../types';
import DiaryEntryItem from './DiaryEntryItem';

interface MealSectionProps {
  mealType: MealType;
  entries: DiaryEntryWithFood[];
  onAddPress: () => void;
  onDeleteEntry: (entryId: number) => void;
}

const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Colazione',
  lunch: 'Pranzo',
  dinner: 'Cena',
  snack: 'Spuntino',
};

const MealSection: React.FC<MealSectionProps> = ({
  mealType,
  entries,
  onAddPress,
  onDeleteEntry,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const totalCalories = entries.reduce(
    (sum, entry) => sum + entry.food.calories * entry.quantity,
    0
  );

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  return (
    <View style={styles.container}>
      <Pressable
        style={({ pressed }) => [
          styles.header,
          pressed && styles.headerPressed,
        ]}
        onPress={toggleCollapse}
      >
        <View style={styles.headerLeft}>
          <Text style={styles.chevron}>{isCollapsed ? '›' : '∨'}</Text>
          <Text style={styles.mealLabel}>{MEAL_LABELS[mealType]}</Text>
          <Text style={styles.calories}>{Math.round(totalCalories)} cal</Text>
        </View>
        <Pressable
          style={({ pressed }) => [
            styles.addButton,
            pressed && styles.addButtonPressed,
          ]}
          onPress={(e) => {
            e.stopPropagation();
            onAddPress();
          }}
        >
          <Text style={styles.addIcon}>+</Text>
        </Pressable>
      </Pressable>

      {!isCollapsed && (
        <View style={styles.entriesContainer}>
          {entries.length === 0 ? (
            <Text style={styles.emptyText}>Nessun elemento</Text>
          ) : (
            entries.map((entry) => (
              <DiaryEntryItem
                key={entry.id}
                entry={entry}
                onDelete={() => onDeleteEntry(entry.id)}
              />
            ))
          )}
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    marginVertical: 8,
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FAFAFA',
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  headerPressed: {
    backgroundColor: '#F5F5F5',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  chevron: {
    fontSize: 16,
    color: '#757575',
    marginRight: 8,
    width: 16,
  },
  mealLabel: {
    fontSize: 18,
    fontWeight: '700',
    color: '#212121',
    marginRight: 12,
  },
  calories: {
    fontSize: 15,
    fontWeight: '600',
    color: '#4CAF50',
  },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#4CAF50',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  addButtonPressed: {
    backgroundColor: '#45A049',
  },
  addIcon: {
    fontSize: 24,
    color: '#FFFFFF',
    fontWeight: '400',
  },
  entriesContainer: {
    backgroundColor: '#FFFFFF',
  },
  emptyText: {
    textAlign: 'center',
    padding: 20,
    fontSize: 14,
    color: '#BDBDBD',
    fontStyle: 'italic',
  },
});

export default MealSection;
