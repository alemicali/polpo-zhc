import { create } from 'zustand';
import type { Food } from '../types';
import * as foodRepo from '../database/repositories/foodRepository';

interface FoodState {
  searchResults: Food[];
  recentFoods: Food[];
  searchQuery: string;
  loading: boolean;
  search: (query: string) => Promise<void>;
  loadRecent: () => Promise<void>;
  addCustomFood: (food: Omit<Food, 'id' | 'created_at'>) => Promise<Food>;
}

export const useFoodStore = create<FoodState>((set, get) => ({
  searchResults: [],
  recentFoods: [],
  searchQuery: '',
  loading: false,

  search: async (query: string) => {
    set({ searchQuery: query, loading: true });
    try {
      if (query.trim() === '') {
        set({ searchResults: [], loading: false });
        return;
      }
      const results = await foodRepo.searchFoods(query);
      set({ searchResults: results, loading: false });
    } catch (error) {
      console.error('Failed to search foods:', error);
      set({ searchResults: [], loading: false });
    }
  },

  loadRecent: async () => {
    set({ loading: true });
    try {
      const recent = await foodRepo.getRecentFoods(10);
      set({ recentFoods: recent, loading: false });
    } catch (error) {
      console.error('Failed to load recent foods:', error);
      set({ recentFoods: [], loading: false });
    }
  },

  addCustomFood: async (food: Omit<Food, 'id' | 'created_at'>) => {
    set({ loading: true });
    try {
      const newFood = await foodRepo.addFood(food);
      set({ loading: false });
      return newFood;
    } catch (error) {
      console.error('Failed to add custom food:', error);
      set({ loading: false });
      throw error;
    }
  },
}));
