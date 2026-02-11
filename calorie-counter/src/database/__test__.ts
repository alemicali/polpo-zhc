/**
 * Simple validation test for database layer
 * This file verifies that all imports and types are correct
 */

import { initDatabase, getDatabase, closeDatabase } from './db';
import { CREATE_TABLES, SEED_DEFAULT_GOALS, SCHEMA_VERSION } from './schema';
import * as foodRepository from './repositories/foodRepository';
import * as diaryRepository from './repositories/diaryRepository';
import * as goalsRepository from './repositories/goalsRepository';
import type {
  Food,
  DiaryEntry,
  DailyGoals,
  MealType,
  NutrientTotals,
  DiaryEntryWithFood,
} from '../types';

// Verify all exports are available
const dbFunctions = {
  initDatabase,
  getDatabase,
  closeDatabase,
};

const schema = {
  CREATE_TABLES,
  SEED_DEFAULT_GOALS,
  SCHEMA_VERSION,
};

const repositories = {
  food: foodRepository,
  diary: diaryRepository,
  goals: goalsRepository,
};

// Type checks
const mealTypes: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];

console.log('Database layer validation: All imports and types are correct');

export { dbFunctions, schema, repositories, mealTypes };
