export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface Food {
  id: number;
  name: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  serving_size: string;
  barcode: string | null;
  is_custom: boolean;
  created_at: string;
}

export interface DiaryEntry {
  id: number;
  food_id: number;
  date: string; // ISO format YYYY-MM-DD
  meal_type: MealType;
  quantity: number;
  created_at: string;
}

export interface DailyGoals {
  id: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface NutrientTotals {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface DiaryEntryWithFood extends DiaryEntry {
  food: Food;
}
