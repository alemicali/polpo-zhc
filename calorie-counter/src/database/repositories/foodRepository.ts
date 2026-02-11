import { getDatabase } from '../db';
import type { Food } from '../../types';

/**
 * Add a new food to the database
 */
export async function addFood(food: Omit<Food, 'id' | 'created_at'>): Promise<Food> {
  const db = getDatabase();

  try {
    const result = await db.runAsync(
      `INSERT INTO foods (name, calories, protein, carbs, fat, serving_size, barcode, is_custom)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        food.name,
        food.calories,
        food.protein,
        food.carbs,
        food.fat,
        food.serving_size,
        food.barcode,
        food.is_custom ? 1 : 0,
      ]
    );

    const insertedFood = await db.getFirstAsync<Food>(
      'SELECT * FROM foods WHERE id = ?',
      [result.lastInsertRowId]
    );

    if (!insertedFood) {
      throw new Error('Failed to retrieve inserted food');
    }

    return {
      ...insertedFood,
      is_custom: Boolean(insertedFood.is_custom),
    };
  } catch (error) {
    console.error('Error adding food:', error);
    throw new Error('Failed to add food to database');
  }
}

/**
 * Search foods by name
 */
export async function searchFoods(query: string): Promise<Food[]> {
  const db = getDatabase();

  try {
    const foods = await db.getAllAsync<Food>(
      `SELECT * FROM foods
       WHERE name LIKE ?
       ORDER BY
         CASE WHEN name LIKE ? THEN 0 ELSE 1 END,
         name ASC
       LIMIT 50`,
      [`%${query}%`, `${query}%`]
    );

    return foods.map(food => ({
      ...food,
      is_custom: Boolean(food.is_custom),
    }));
  } catch (error) {
    console.error('Error searching foods:', error);
    throw new Error('Failed to search foods');
  }
}

/**
 * Get a food by ID
 */
export async function getFoodById(id: number): Promise<Food | null> {
  const db = getDatabase();

  try {
    const food = await db.getFirstAsync<Food>(
      'SELECT * FROM foods WHERE id = ?',
      [id]
    );

    if (!food) {
      return null;
    }

    return {
      ...food,
      is_custom: Boolean(food.is_custom),
    };
  } catch (error) {
    console.error('Error getting food by ID:', error);
    throw new Error('Failed to retrieve food');
  }
}

/**
 * Get recently used foods
 */
export async function getRecentFoods(limit: number = 10): Promise<Food[]> {
  const db = getDatabase();

  try {
    const foods = await db.getAllAsync<Food>(
      `SELECT DISTINCT f.*
       FROM foods f
       INNER JOIN diary_entries de ON f.id = de.food_id
       ORDER BY de.created_at DESC
       LIMIT ?`,
      [limit]
    );

    return foods.map(food => ({
      ...food,
      is_custom: Boolean(food.is_custom),
    }));
  } catch (error) {
    console.error('Error getting recent foods:', error);
    throw new Error('Failed to retrieve recent foods');
  }
}

/**
 * Get a food by barcode
 */
export async function getFoodByBarcode(barcode: string): Promise<Food | null> {
  const db = getDatabase();

  try {
    const food = await db.getFirstAsync<Food>(
      'SELECT * FROM foods WHERE barcode = ?',
      [barcode]
    );

    if (!food) {
      return null;
    }

    return {
      ...food,
      is_custom: Boolean(food.is_custom),
    };
  } catch (error) {
    console.error('Error getting food by barcode:', error);
    throw new Error('Failed to retrieve food by barcode');
  }
}

/**
 * Update an existing food
 */
export async function updateFood(
  id: number,
  updates: Partial<Omit<Food, 'id' | 'created_at'>>
): Promise<Food> {
  const db = getDatabase();

  try {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) {
      fields.push('name = ?');
      values.push(updates.name);
    }
    if (updates.calories !== undefined) {
      fields.push('calories = ?');
      values.push(updates.calories);
    }
    if (updates.protein !== undefined) {
      fields.push('protein = ?');
      values.push(updates.protein);
    }
    if (updates.carbs !== undefined) {
      fields.push('carbs = ?');
      values.push(updates.carbs);
    }
    if (updates.fat !== undefined) {
      fields.push('fat = ?');
      values.push(updates.fat);
    }
    if (updates.serving_size !== undefined) {
      fields.push('serving_size = ?');
      values.push(updates.serving_size);
    }
    if (updates.barcode !== undefined) {
      fields.push('barcode = ?');
      values.push(updates.barcode);
    }
    if (updates.is_custom !== undefined) {
      fields.push('is_custom = ?');
      values.push(updates.is_custom ? 1 : 0);
    }

    if (fields.length === 0) {
      throw new Error('No fields to update');
    }

    values.push(id);

    await db.runAsync(
      `UPDATE foods SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    const updatedFood = await getFoodById(id);
    if (!updatedFood) {
      throw new Error('Failed to retrieve updated food');
    }

    return updatedFood;
  } catch (error) {
    console.error('Error updating food:', error);
    throw new Error('Failed to update food');
  }
}

/**
 * Delete a food (and cascade delete related diary entries)
 */
export async function deleteFood(id: number): Promise<void> {
  const db = getDatabase();

  try {
    await db.runAsync('DELETE FROM foods WHERE id = ?', [id]);
  } catch (error) {
    console.error('Error deleting food:', error);
    throw new Error('Failed to delete food');
  }
}
