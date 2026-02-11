import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Food } from '../types';
import MacroPills from './MacroPills';

interface FoodListItemProps {
  food: Food;
  onPress: () => void;
}

const FoodListItem: React.FC<FoodListItemProps> = ({ food, onPress }) => {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.name} numberOfLines={1}>
            {food.name}
          </Text>
          <Text style={styles.calories}>{Math.round(food.calories)} cal</Text>
        </View>
        <View style={styles.footer}>
          <Text style={styles.servingSize}>{food.serving_size}</Text>
          <MacroPills
            protein={food.protein}
            carbs={food.carbs}
            fat={food.fat}
          />
        </View>
      </View>
      <View style={styles.arrow}>
        <Text style={styles.arrowText}>›</Text>
      </View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    padding: 16,
    marginVertical: 4,
    marginHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  pressed: {
    backgroundColor: '#F5F5F5',
    opacity: 0.8,
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: '#212121',
    flex: 1,
    marginRight: 12,
  },
  calories: {
    fontSize: 15,
    fontWeight: '700',
    color: '#4CAF50',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  servingSize: {
    fontSize: 13,
    color: '#757575',
  },
  arrow: {
    marginLeft: 12,
  },
  arrowText: {
    fontSize: 24,
    color: '#BDBDBD',
  },
});

export default FoodListItem;
