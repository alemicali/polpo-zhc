import { create } from 'zustand';
import type { DiaryEntry, DiaryEntryWithFood, NutrientTotals, MealType } from '../types';
import * as diaryRepo from '../database/repositories/diaryRepository';

interface DiaryState {
  selectedDate: string;
  entries: DiaryEntryWithFood[];
  totals: NutrientTotals;
  loading: boolean;
  setDate: (date: string) => void;
  loadEntries: (date: string) => Promise<void>;
  addEntry: (foodId: number, mealType: MealType, quantity: number) => Promise<void>;
  removeEntry: (id: number) => Promise<void>;
  refreshTotals: () => Promise<void>;
}

const getInitialDate = (): string => {
  const today = new Date();
  return today.toISOString().split('T')[0];
};

const initialTotals: NutrientTotals = {
  calories: 0,
  protein: 0,
  carbs: 0,
  fat: 0,
};

export const useDiaryStore = create<DiaryState>((set, get) => ({
  selectedDate: getInitialDate(),
  entries: [],
  totals: initialTotals,
  loading: false,

  setDate: (date: string) => {
    set({ selectedDate: date });
    get().loadEntries(date);
  },

  loadEntries: async (date: string) => {
    set({ loading: true });
    try {
      const entries = await diaryRepo.getEntriesByDate(date);
      const totals = await diaryRepo.getDailyTotals(date);
      set({ entries, totals, loading: false });
    } catch (error) {
      console.error('Failed to load entries:', error);
      set({ entries: [], totals: initialTotals, loading: false });
    }
  },

  addEntry: async (foodId: number, mealType: MealType, quantity: number) => {
    const { selectedDate } = get();
    set({ loading: true });
    try {
      await diaryRepo.addEntry({
        food_id: foodId,
        date: selectedDate,
        meal_type: mealType,
        quantity,
      });
      await get().loadEntries(selectedDate);
    } catch (error) {
      console.error('Failed to add entry:', error);
      set({ loading: false });
      throw error;
    }
  },

  removeEntry: async (id: number) => {
    const { selectedDate } = get();
    set({ loading: true });
    try {
      await diaryRepo.deleteEntry(id);
      await get().loadEntries(selectedDate);
    } catch (error) {
      console.error('Failed to remove entry:', error);
      set({ loading: false });
      throw error;
    }
  },

  refreshTotals: async () => {
    const { selectedDate } = get();
    try {
      const totals = await diaryRepo.getDailyTotals(selectedDate);
      set({ totals });
    } catch (error) {
      console.error('Failed to refresh totals:', error);
      throw error;
    }
  },
}));
