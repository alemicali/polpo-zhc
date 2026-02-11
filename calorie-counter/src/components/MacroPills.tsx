import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface MacroPillsProps {
  protein: number;
  carbs: number;
  fat: number;
}

const MacroPills: React.FC<MacroPillsProps> = ({ protein, carbs, fat }) => {
  return (
    <View style={styles.container}>
      <View style={[styles.pill, styles.proteinPill]}>
        <Text style={styles.pillText}>P {Math.round(protein)}g</Text>
      </View>
      <View style={[styles.pill, styles.carbsPill]}>
        <Text style={styles.pillText}>C {Math.round(carbs)}g</Text>
      </View>
      <View style={[styles.pill, styles.fatPill]}>
        <Text style={styles.pillText}>F {Math.round(fat)}g</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 6,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  proteinPill: {
    backgroundColor: '#E3F2FD',
  },
  carbsPill: {
    backgroundColor: '#FFF3E0',
  },
  fatPill: {
    backgroundColor: '#F3E5F5',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#212121',
  },
});

export default MacroPills;
