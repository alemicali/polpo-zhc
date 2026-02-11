import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { NutrientTotals, DailyGoals } from '../types';
import NutrientBar from './NutrientBar';

interface DailySummaryCardProps {
  totals: NutrientTotals;
  goals: DailyGoals;
}

const DailySummaryCard: React.FC<DailySummaryCardProps> = ({ totals, goals }) => {
  const caloriePercentage = Math.min((totals.calories / goals.calories) * 100, 100);
  const remaining = Math.max(goals.calories - totals.calories, 0);
  const isOverGoal = totals.calories > goals.calories;

  // SVG circle parameters for circular progress
  const size = 180;
  const strokeWidth = 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (caloriePercentage / 100) * circumference;

  return (
    <View style={styles.card}>
      {/* Calorie Ring */}
      <View style={styles.ringContainer}>
        <View style={styles.ring}>
          <View style={styles.ringBackground}>
            <View
              style={[
                styles.ringProgress,
                {
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                  borderWidth: strokeWidth,
                  borderColor: '#E0E0E0',
                },
              ]}
            >
              <View
                style={[
                  styles.ringProgressFill,
                  {
                    width: size - strokeWidth * 2,
                    height: size - strokeWidth * 2,
                    borderRadius: (size - strokeWidth * 2) / 2,
                    borderWidth: strokeWidth,
                    borderColor: isOverGoal ? '#F44336' : '#4CAF50',
                    borderTopColor: 'transparent',
                    borderRightColor: caloriePercentage > 50 ? (isOverGoal ? '#F44336' : '#4CAF50') : 'transparent',
                    transform: [{ rotate: `${(caloriePercentage / 100) * 360}deg` }],
                  },
                ]}
              />
            </View>
          </View>
          <View style={styles.ringCenter}>
            <Text style={[styles.calorieNumber, isOverGoal && styles.overGoalText]}>
              {Math.round(totals.calories)}
            </Text>
            <Text style={styles.calorieLabel}>calories</Text>
            <Text style={styles.remaining}>
              {isOverGoal ? `+${Math.round(totals.calories - goals.calories)}` : Math.round(remaining)} {isOverGoal ? 'over' : 'left'}
            </Text>
          </View>
        </View>
      </View>

      {/* Macro Bars */}
      <View style={styles.macroSection}>
        <NutrientBar
          label="Protein"
          current={totals.protein}
          goal={goals.protein}
          color="#2196F3"
          unit="g"
        />
        <NutrientBar
          label="Carbs"
          current={totals.carbs}
          goal={goals.carbs}
          color="#FF9800"
          unit="g"
        />
        <NutrientBar
          label="Fat"
          current={totals.fat}
          goal={goals.fat}
          color="#9C27B0"
          unit="g"
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    marginVertical: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  ringContainer: {
    alignItems: 'center',
    marginBottom: 24,
  },
  ring: {
    position: 'relative',
    width: 180,
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringBackground: {
    position: 'absolute',
  },
  ringProgress: {
    position: 'relative',
  },
  ringProgressFill: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  ringCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  calorieNumber: {
    fontSize: 48,
    fontWeight: '700',
    color: '#212121',
  },
  overGoalText: {
    color: '#F44336',
  },
  calorieLabel: {
    fontSize: 14,
    color: '#757575',
    marginTop: 4,
  },
  remaining: {
    fontSize: 16,
    fontWeight: '600',
    color: '#4CAF50',
    marginTop: 8,
  },
  macroSection: {
    marginTop: 8,
  },
});

export default DailySummaryCard;
