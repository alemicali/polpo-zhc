import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface NutrientBarProps {
  label: string;
  current: number;
  goal: number;
  color: string;
  unit?: string;
}

const NutrientBar: React.FC<NutrientBarProps> = ({
  label,
  current,
  goal,
  color,
  unit = 'g',
}) => {
  const percentage = Math.min((current / goal) * 100, 100);
  const isOverGoal = current > goal;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.values}>
          <Text style={[styles.current, isOverGoal && styles.overGoal]}>
            {Math.round(current)}
          </Text>
          <Text style={styles.separator}> / </Text>
          <Text style={styles.goal}>{Math.round(goal)}</Text>
          <Text style={styles.unit}> {unit}</Text>
        </Text>
      </View>
      <View style={styles.barContainer}>
        <View
          style={[
            styles.barFill,
            {
              width: `${percentage}%`,
              backgroundColor: isOverGoal ? '#F44336' : color,
            },
          ]}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginVertical: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#212121',
  },
  values: {
    fontSize: 14,
  },
  current: {
    fontWeight: '700',
    color: '#212121',
  },
  overGoal: {
    color: '#F44336',
  },
  separator: {
    color: '#757575',
  },
  goal: {
    color: '#757575',
  },
  unit: {
    fontSize: 12,
    color: '#757575',
  },
  barContainer: {
    height: 8,
    backgroundColor: '#E0E0E0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 4,
  },
});

export default NutrientBar;
