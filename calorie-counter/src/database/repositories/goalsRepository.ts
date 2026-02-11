import { getDatabase } from '../db';
import type { DailyGoals } from '../../types';

/**
 * Get the current daily goals (always returns the first record)
 */
export async function getGoals(): Promise<DailyGoals> {
  const db = getDatabase();

  try {
    const goals = await db.getFirstAsync<DailyGoals>(
      'SELECT * FROM daily_goals WHERE id = 1'
    );

    if (!goals) {
      // This should never happen due to seed data, but handle it gracefully
      throw new Error('Daily goals not found. Database may not be initialized properly.');
    }

    return goals;
  } catch (error) {
    console.error('Error getting daily goals:', error);
    throw new Error('Failed to retrieve daily goals');
  }
}

/**
 * Update the daily goals
 */
export async function updateGoals(
  updates: Partial<Omit<DailyGoals, 'id'>>
): Promise<DailyGoals> {
  const db = getDatabase();

  try {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.calories !== undefined) {
      if (updates.calories < 0) {
        throw new Error('Calories goal must be non-negative');
      }
      fields.push('calories = ?');
      values.push(updates.calories);
    }

    if (updates.protein !== undefined) {
      if (updates.protein < 0) {
        throw new Error('Protein goal must be non-negative');
      }
      fields.push('protein = ?');
      values.push(updates.protein);
    }

    if (updates.carbs !== undefined) {
      if (updates.carbs < 0) {
        throw new Error('Carbs goal must be non-negative');
      }
      fields.push('carbs = ?');
      values.push(updates.carbs);
    }

    if (updates.fat !== undefined) {
      if (updates.fat < 0) {
        throw new Error('Fat goal must be non-negative');
      }
      fields.push('fat = ?');
      values.push(updates.fat);
    }

    if (fields.length === 0) {
      throw new Error('No fields to update');
    }

    values.push(1); // id is always 1

    await db.runAsync(
      `UPDATE daily_goals SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return await getGoals();
  } catch (error) {
    console.error('Error updating daily goals:', error);
    throw new Error('Failed to update daily goals');
  }
}

/**
 * Reset goals to default values
 */
export async function resetGoalsToDefaults(): Promise<DailyGoals> {
  const db = getDatabase();

  try {
    await db.runAsync(
      `UPDATE daily_goals
       SET calories = 2000, protein = 50, carbs = 250, fat = 65
       WHERE id = 1`
    );

    return await getGoals();
  } catch (error) {
    console.error('Error resetting goals to defaults:', error);
    throw new Error('Failed to reset goals');
  }
}

/**
 * Calculate percentage progress toward goals for given totals
 */
export function calculateProgress(
  totals: { calories: number; protein: number; carbs: number; fat: number },
  goals: DailyGoals
): {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
} {
  return {
    calories: goals.calories > 0 ? (totals.calories / goals.calories) * 100 : 0,
    protein: goals.protein > 0 ? (totals.protein / goals.protein) * 100 : 0,
    carbs: goals.carbs > 0 ? (totals.carbs / goals.carbs) * 100 : 0,
    fat: goals.fat > 0 ? (totals.fat / goals.fat) * 100 : 0,
  };
}
