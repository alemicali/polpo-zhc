import * as SQLite from 'expo-sqlite';
import { WebSQLiteDatabase } from './web-db';

// Union type to handle both native and web databases
type DatabaseInstance = SQLite.SQLiteDatabase | WebSQLiteDatabase;

/**
 * Common Italian foods with nutritional data per serving
 */
const DEFAULT_FOODS = [
  // Pasta varieties
  { name: 'Spaghetti', calories: 350, protein: 13, carbs: 71, fat: 1.5, serving_size: '100g' },
  { name: 'Penne', calories: 352, protein: 12.5, carbs: 72, fat: 1.5, serving_size: '100g' },
  { name: 'Fusilli', calories: 350, protein: 13, carbs: 71, fat: 1.5, serving_size: '100g' },
  { name: 'Risotto', calories: 130, protein: 2.7, carbs: 28, fat: 0.3, serving_size: '100g cotto' },

  // Bread
  { name: 'Pane bianco', calories: 265, protein: 9, carbs: 49, fat: 3.2, serving_size: '100g' },
  { name: 'Pane integrale', calories: 247, protein: 13, carbs: 41, fat: 3.4, serving_size: '100g' },
  { name: 'Focaccia', calories: 280, protein: 7, carbs: 45, fat: 8, serving_size: '100g' },

  // Rice
  { name: 'Riso bianco cotto', calories: 130, protein: 2.7, carbs: 28, fat: 0.3, serving_size: '100g' },
  { name: 'Riso integrale cotto', calories: 111, protein: 2.6, carbs: 23, fat: 0.9, serving_size: '100g' },

  // Meat
  { name: 'Petto di pollo', calories: 165, protein: 31, carbs: 0, fat: 3.6, serving_size: '100g' },
  { name: 'Coscia di pollo', calories: 209, protein: 26, carbs: 0, fat: 11, serving_size: '100g' },
  { name: 'Bresaola', calories: 150, protein: 32, carbs: 0.6, fat: 2.6, serving_size: '100g' },
  { name: 'Prosciutto crudo', calories: 250, protein: 26, carbs: 0.5, fat: 16, serving_size: '100g' },
  { name: 'Prosciutto cotto', calories: 145, protein: 19.8, carbs: 0.9, fat: 6.8, serving_size: '100g' },
  { name: 'Mortadella', calories: 311, protein: 15, carbs: 2.2, fat: 27, serving_size: '100g' },

  // Fish
  { name: 'Tonno in scatola', calories: 130, protein: 26, carbs: 0, fat: 3, serving_size: '100g' },
  { name: 'Salmone', calories: 208, protein: 20, carbs: 0, fat: 13, serving_size: '100g' },

  // Eggs and dairy
  { name: 'Uova', calories: 155, protein: 13, carbs: 1.1, fat: 11, serving_size: '100g (2 uova)' },
  { name: 'Mozzarella', calories: 280, protein: 28, carbs: 2.2, fat: 17, serving_size: '100g' },
  { name: 'Parmigiano Reggiano', calories: 431, protein: 38, carbs: 4.1, fat: 29, serving_size: '100g' },
  { name: 'Grana Padano', calories: 384, protein: 33, carbs: 0, fat: 28, serving_size: '100g' },
  { name: 'Ricotta', calories: 174, protein: 11, carbs: 3, fat: 13, serving_size: '100g' },
  { name: 'Latte intero', calories: 64, protein: 3.3, carbs: 5, fat: 3.6, serving_size: '100ml' },
  { name: 'Yogurt greco', calories: 97, protein: 9, carbs: 3.6, fat: 5, serving_size: '100g' },

  // Vegetables
  { name: 'Pomodoro', calories: 18, protein: 0.9, carbs: 3.9, fat: 0.2, serving_size: '100g' },
  { name: 'Insalata mista', calories: 20, protein: 1.5, carbs: 3.5, fat: 0.3, serving_size: '100g' },
  { name: 'Zucchine', calories: 17, protein: 1.2, carbs: 3.1, fat: 0.3, serving_size: '100g' },
  { name: 'Melanzane', calories: 25, protein: 1, carbs: 6, fat: 0.2, serving_size: '100g' },
  { name: 'Peperoni', calories: 31, protein: 1, carbs: 6, fat: 0.3, serving_size: '100g' },

  // Fruits
  { name: 'Mela', calories: 52, protein: 0.3, carbs: 14, fat: 0.2, serving_size: '100g' },
  { name: 'Banana', calories: 89, protein: 1.1, carbs: 23, fat: 0.3, serving_size: '100g' },
  { name: 'Arancia', calories: 47, protein: 0.9, carbs: 12, fat: 0.1, serving_size: '100g' },
  { name: 'Pera', calories: 57, protein: 0.4, carbs: 15, fat: 0.1, serving_size: '100g' },
  { name: 'Fragole', calories: 32, protein: 0.7, carbs: 7.7, fat: 0.3, serving_size: '100g' },

  // Prepared foods
  { name: 'Pizza margherita', calories: 266, protein: 11, carbs: 33, fat: 10, serving_size: '100g' },
  { name: 'Lasagne', calories: 135, protein: 7.6, carbs: 11, fat: 6.5, serving_size: '100g' },

  // Oils and fats
  { name: 'Olio d\'oliva', calories: 884, protein: 0, carbs: 0, fat: 100, serving_size: '100ml' },
  { name: 'Burro', calories: 717, protein: 0.9, carbs: 0.1, fat: 81, serving_size: '100g' },

  // Sweets and snacks
  { name: 'Biscotti secchi', calories: 450, protein: 7, carbs: 70, fat: 15, serving_size: '100g' },
  { name: 'Gelato', calories: 200, protein: 3.5, carbs: 25, fat: 10, serving_size: '100g' },
  { name: 'Cioccolato fondente', calories: 546, protein: 5, carbs: 61, fat: 31, serving_size: '100g' },
  { name: 'Nutella', calories: 539, protein: 6.3, carbs: 57, fat: 31, serving_size: '100g' },

  // Beverages
  { name: 'Caffè espresso', calories: 2, protein: 0.1, carbs: 0, fat: 0, serving_size: '1 tazzina (30ml)' },
  { name: 'Cappuccino', calories: 73, protein: 4, carbs: 6, fat: 4, serving_size: '1 tazza (150ml)' },

  // Legumes
  { name: 'Fagioli cotti', calories: 127, protein: 8.7, carbs: 22.8, fat: 0.5, serving_size: '100g' },
  { name: 'Lenticchie cotte', calories: 116, protein: 9, carbs: 20, fat: 0.4, serving_size: '100g' },
  { name: 'Ceci cotti', calories: 164, protein: 8.9, carbs: 27.4, fat: 2.6, serving_size: '100g' },
];

/**
 * Seed the database with default Italian foods if the table is empty
 */
export async function seedDefaultFoods(db: DatabaseInstance): Promise<void> {
  try {
    // Check if foods table already has data
    const result = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM foods WHERE is_custom = 0;'
    );

    const seedCount = result?.count ?? 0;

    if (seedCount > 0) {
      console.log(`Database already contains ${seedCount} seeded foods. Skipping seed.`);
      return;
    }

    console.log('Seeding default Italian foods...');

    // Insert all default foods in a transaction
    await db.execAsync('BEGIN TRANSACTION;');

    for (const food of DEFAULT_FOODS) {
      await db.runAsync(
        `INSERT INTO foods (name, calories, protein, carbs, fat, serving_size, is_custom)
         VALUES (?, ?, ?, ?, ?, ?, 0);`,
        [food.name, food.calories, food.protein, food.carbs, food.fat, food.serving_size]
      );
    }

    await db.execAsync('COMMIT;');

    console.log(`Successfully seeded ${DEFAULT_FOODS.length} default foods.`);
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    console.error('Failed to seed default foods:', error);
    throw error;
  }
}
