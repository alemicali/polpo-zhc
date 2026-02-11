import { getDatabase } from '../db';
import type { DiaryEntry, DiaryEntryWithFood, Food, NutrientTotals, MealType } from '../../types';

/**
 * Add a new diary entry
 */
export async function addEntry(
  entry: Omit<DiaryEntry, 'id' | 'created_at'>
): Promise<DiaryEntry> {
  const db = getDatabase();

  try {
    const result = await db.runAsync(
      `INSERT INTO diary_entries (food_id, date, meal_type, quantity)
       VALUES (?, ?, ?, ?)`,
      [entry.food_id, entry.date, entry.meal_type, entry.quantity]
    );

    const insertedEntry = await db.getFirstAsync<DiaryEntry>(
      'SELECT * FROM diary_entries WHERE id = ?',
      [result.lastInsertRowId]
    );

    if (!insertedEntry) {
      throw new Error('Failed to retrieve inserted entry');
    }

    return insertedEntry;
  } catch (error) {
    console.error('Error adding diary entry:', error);
    throw new Error('Failed to add diary entry');
  }
}

/**
 * Get all diary entries for a specific date with food details
 */
export async function getEntriesByDate(date: string): Promise<DiaryEntryWithFood[]> {
  const db = getDatabase();

  try {
    const entries = await db.getAllAsync<any>(
      `SELECT
        de.*,
        f.id as food_id,
        f.name,
        f.calories,
        f.protein,
        f.carbs,
        f.fat,
        f.serving_size,
        f.barcode,
        f.is_custom,
        f.created_at as food_created_at
       FROM diary_entries de
       INNER JOIN foods f ON de.food_id = f.id
       WHERE de.date = ?
       ORDER BY
         CASE de.meal_type
           WHEN 'breakfast' THEN 1
           WHEN 'lunch' THEN 2
           WHEN 'dinner' THEN 3
           WHEN 'snack' THEN 4
         END,
         de.created_at ASC`,
      [date]
    );

    return entries.map((entry: any) => ({
      id: entry.id,
      food_id: entry.food_id,
      date: entry.date,
      meal_type: entry.meal_type as MealType,
      quantity: entry.quantity,
      created_at: entry.created_at,
      food: {
        id: entry.food_id,
        name: entry.name,
        calories: entry.calories,
        protein: entry.protein,
        carbs: entry.carbs,
        fat: entry.fat,
        serving_size: entry.serving_size,
        barcode: entry.barcode,
        is_custom: Boolean(entry.is_custom),
        created_at: entry.food_created_at,
      },
    }));
  } catch (error) {
    console.error('Error getting diary entries by date:', error);
    throw new Error('Failed to retrieve diary entries');
  }
}

/**
 * Get entries grouped by meal type for a specific date
 */
export async function getEntriesByDateGrouped(date: string): Promise<{
  breakfast: DiaryEntryWithFood[];
  lunch: DiaryEntryWithFood[];
  dinner: DiaryEntryWithFood[];
  snack: DiaryEntryWithFood[];
}> {
  const entries = await getEntriesByDate(date);

  return {
    breakfast: entries.filter(e => e.meal_type === 'breakfast'),
    lunch: entries.filter(e => e.meal_type === 'lunch'),
    dinner: entries.filter(e => e.meal_type === 'dinner'),
    snack: entries.filter(e => e.meal_type === 'snack'),
  };
}

/**
 * Delete a diary entry
 */
export async function deleteEntry(id: number): Promise<void> {
  const db = getDatabase();

  try {
    const result = await db.runAsync(
      'DELETE FROM diary_entries WHERE id = ?',
      [id]
    );

    if (result.changes === 0) {
      throw new Error('Entry not found');
    }
  } catch (error) {
    console.error('Error deleting diary entry:', error);
    throw new Error('Failed to delete diary entry');
  }
}

/**
 * Update the quantity of a diary entry
 */
export async function updateEntryQuantity(
  id: number,
  quantity: number
): Promise<DiaryEntry> {
  const db = getDatabase();

  try {
    if (quantity <= 0) {
      throw new Error('Quantity must be greater than 0');
    }

    await db.runAsync(
      'UPDATE diary_entries SET quantity = ? WHERE id = ?',
      [quantity, id]
    );

    const updatedEntry = await db.getFirstAsync<DiaryEntry>(
      'SELECT * FROM diary_entries WHERE id = ?',
      [id]
    );

    if (!updatedEntry) {
      throw new Error('Failed to retrieve updated entry');
    }

    return updatedEntry;
  } catch (error) {
    console.error('Error updating entry quantity:', error);
    throw new Error('Failed to update entry quantity');
  }
}

/**
 * Calculate daily nutrient totals for a specific date
 */
export async function getDailyTotals(date: string): Promise<NutrientTotals> {
  const db = getDatabase();

  try {
    const result = await db.getFirstAsync<NutrientTotals>(
      `SELECT
         COALESCE(SUM(f.calories * de.quantity), 0) as calories,
         COALESCE(SUM(f.protein * de.quantity), 0) as protein,
         COALESCE(SUM(f.carbs * de.quantity), 0) as carbs,
         COALESCE(SUM(f.fat * de.quantity), 0) as fat
       FROM diary_entries de
       INNER JOIN foods f ON de.food_id = f.id
       WHERE de.date = ?`,
      [date]
    );

    return {
      calories: result?.calories ?? 0,
      protein: result?.protein ?? 0,
      carbs: result?.carbs ?? 0,
      fat: result?.fat ?? 0,
    };
  } catch (error) {
    console.error('Error calculating daily totals:', error);
    throw new Error('Failed to calculate daily totals');
  }
}

/**
 * Get nutrient totals by meal type for a specific date
 */
export async function getMealTotals(
  date: string,
  mealType: MealType
): Promise<NutrientTotals> {
  const db = getDatabase();

  try {
    const result = await db.getFirstAsync<NutrientTotals>(
      `SELECT
         COALESCE(SUM(f.calories * de.quantity), 0) as calories,
         COALESCE(SUM(f.protein * de.quantity), 0) as protein,
         COALESCE(SUM(f.carbs * de.quantity), 0) as carbs,
         COALESCE(SUM(f.fat * de.quantity), 0) as fat
       FROM diary_entries de
       INNER JOIN foods f ON de.food_id = f.id
       WHERE de.date = ? AND de.meal_type = ?`,
      [date, mealType]
    );

    return {
      calories: result?.calories ?? 0,
      protein: result?.protein ?? 0,
      carbs: result?.carbs ?? 0,
      fat: result?.fat ?? 0,
    };
  } catch (error) {
    console.error('Error calculating meal totals:', error);
    throw new Error('Failed to calculate meal totals');
  }
}

/**
 * Get date range of entries (for history/stats)
 */
export async function getDateRange(): Promise<{ minDate: string | null; maxDate: string | null }> {
  const db = getDatabase();

  try {
    const result = await db.getFirstAsync<{ minDate: string | null; maxDate: string | null }>(
      'SELECT MIN(date) as minDate, MAX(date) as maxDate FROM diary_entries'
    );

    return {
      minDate: result?.minDate ?? null,
      maxDate: result?.maxDate ?? null,
    };
  } catch (error) {
    console.error('Error getting date range:', error);
    throw new Error('Failed to get date range');
  }
}

/**
 * Get all dates that have entries (for calendar highlighting)
 */
export async function getDatesWithEntries(): Promise<string[]> {
  const db = getDatabase();

  try {
    const dates = await db.getAllAsync<{ date: string }>(
      'SELECT DISTINCT date FROM diary_entries ORDER BY date DESC'
    );

    return dates.map(d => d.date);
  } catch (error) {
    console.error('Error getting dates with entries:', error);
    throw new Error('Failed to get dates with entries');
  }
}

/**
 * Clear all diary entries
 */
export async function clearAllEntries(): Promise<void> {
  const db = getDatabase();

  try {
    await db.runAsync('DELETE FROM diary_entries');
  } catch (error) {
    console.error('Error clearing all entries:', error);
    throw new Error('Failed to clear all entries');
  }
}
