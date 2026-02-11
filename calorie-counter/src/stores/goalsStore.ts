import { create } from 'zustand';
import type { DailyGoals } from '../types';
import * as goalsRepo from '../database/repositories/goalsRepository';

interface GoalsState {
  goals: DailyGoals | null;
  loading: boolean;
  loadGoals: () => Promise<void>;
  updateGoals: (updates: Partial<Omit<DailyGoals, 'id'>>) => Promise<void>;
  resetToDefaults: () => Promise<void>;
}

export const useGoalsStore = create<GoalsState>((set, get) => ({
  goals: null,
  loading: false,

  loadGoals: async () => {
    set({ loading: true });
    try {
      const goals = await goalsRepo.getGoals();
      set({ goals, loading: false });
    } catch (error) {
      console.error('Failed to load goals:', error);
      set({ loading: false });
    }
  },

  updateGoals: async (updates: Partial<Omit<DailyGoals, 'id'>>) => {
    set({ loading: true });
    try {
      const updatedGoals = await goalsRepo.updateGoals(updates);
      set({ goals: updatedGoals, loading: false });
    } catch (error) {
      console.error('Failed to update goals:', error);
      set({ loading: false });
      throw error;
    }
  },

  resetToDefaults: async () => {
    set({ loading: true });
    try {
      const resetGoals = await goalsRepo.resetGoalsToDefaults();
      set({ goals: resetGoals, loading: false });
    } catch (error) {
      console.error('Failed to reset goals:', error);
      set({ loading: false });
      throw error;
    }
  },
}));
