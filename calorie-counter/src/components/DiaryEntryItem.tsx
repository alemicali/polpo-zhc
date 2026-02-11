import React from 'react';
import { View, Text, Pressable, StyleSheet, Animated } from 'react-native';
import { DiaryEntryWithFood } from '../types';

interface DiaryEntryItemProps {
  entry: DiaryEntryWithFood;
  onDelete: () => void;
}

const DiaryEntryItem: React.FC<DiaryEntryItemProps> = ({ entry, onDelete }) => {
  const totalCalories = Math.round(entry.food.calories * entry.quantity);
  const totalProtein = entry.food.protein * entry.quantity;
  const totalCarbs = entry.food.carbs * entry.quantity;
  const totalFat = entry.food.fat * entry.quantity;

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <View style={styles.mainInfo}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.food.name}
          </Text>
          <Text style={styles.calories}>{totalCalories} cal</Text>
        </View>
        <View style={styles.details}>
          <Text style={styles.quantity}>
            {entry.quantity} × {entry.food.serving_size}
          </Text>
          <View style={styles.macros}>
            <Text style={styles.macro}>P {Math.round(totalProtein)}g</Text>
            <Text style={styles.macroDivider}>•</Text>
            <Text style={styles.macro}>C {Math.round(totalCarbs)}g</Text>
            <Text style={styles.macroDivider}>•</Text>
            <Text style={styles.macro}>F {Math.round(totalFat)}g</Text>
          </View>
        </View>
      </View>
      <Pressable
        style={({ pressed }) => [
          styles.deleteButton,
          pressed && styles.deleteButtonPressed,
        ]}
        onPress={onDelete}
      >
        <Text style={styles.deleteIcon}>×</Text>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  content: {
    flex: 1,
  },
  mainInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  name: {
    fontSize: 15,
    fontWeight: '500',
    color: '#212121',
    flex: 1,
    marginRight: 12,
  },
  calories: {
    fontSize: 14,
    fontWeight: '700',
    color: '#4CAF50',
  },
  details: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  quantity: {
    fontSize: 13,
    color: '#757575',
  },
  macros: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  macro: {
    fontSize: 12,
    color: '#757575',
  },
  macroDivider: {
    fontSize: 12,
    color: '#BDBDBD',
    marginHorizontal: 6,
  },
  deleteButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#FFEBEE',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  deleteButtonPressed: {
    backgroundColor: '#F44336',
  },
  deleteIcon: {
    fontSize: 24,
    color: '#F44336',
    fontWeight: '400',
  },
});

export default DiaryEntryItem;
