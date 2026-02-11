import { useDiaryStore } from '../../src/stores/diaryStore';
import * as diaryRepo from '../../src/database/repositories/diaryRepository';
import type { DiaryEntryWithFood, NutrientTotals, MealType } from '../../src/types';

// Mock the repository
jest.mock('../../src/database/repositories/diaryRepository');

const mockDiaryRepo = diaryRepo as jest.Mocked<typeof diaryRepo>;

describe('useDiaryStore', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    // Reset the store to initial state
    useDiaryStore.setState({
      selectedDate: new Date().toISOString().split('T')[0],
      entries: [],
      totals: {
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      },
      loading: false,
    });
  });

  describe('setDate', () => {
    it('should update the selected date', () => {
      const store = useDiaryStore.getState();
      const testDate = '2025-02-06';

      store.setDate(testDate);

      expect(useDiaryStore.getState().selectedDate).toBe(testDate);
    });

    it('should trigger loadEntries when date is set', async () => {
      mockDiaryRepo.getEntriesByDate.mockResolvedValue([]);
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });

      const store = useDiaryStore.getState();
      const testDate = '2025-02-06';

      store.setDate(testDate);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockDiaryRepo.getEntriesByDate).toHaveBeenCalledWith(testDate);
    });
  });

  describe('loadEntries', () => {
    it('should set loading to true when loading starts', () => {
      mockDiaryRepo.getEntriesByDate.mockImplementation(
        () =>
          new Promise((resolve) => {
            // Keep it pending to check loading state
            setTimeout(() => resolve([]), 1000);
          })
      );

      const store = useDiaryStore.getState();
      store.loadEntries('2025-02-06');

      expect(useDiaryStore.getState().loading).toBe(true);
    });

    it('should load entries from repository', async () => {
      const mockEntries: DiaryEntryWithFood[] = [
        {
          id: 1,
          food_id: 1,
          date: '2025-02-06',
          meal_type: 'breakfast' as MealType,
          quantity: 1,
          created_at: '2025-02-06T08:00:00Z',
          food: {
            id: 1,
            name: 'Eggs',
            calories: 155,
            protein: 13,
            carbs: 1,
            fat: 11,
            serving_size: '1 large egg',
            barcode: null,
            is_custom: false,
            created_at: '2025-02-06T08:00:00Z',
          },
        },
      ];

      const mockTotals: NutrientTotals = {
        calories: 155,
        protein: 13,
        carbs: 1,
        fat: 11,
      };

      mockDiaryRepo.getEntriesByDate.mockResolvedValue(mockEntries);
      mockDiaryRepo.getDailyTotals.mockResolvedValue(mockTotals);

      const store = useDiaryStore.getState();
      await store.loadEntries('2025-02-06');

      expect(useDiaryStore.getState().entries).toEqual(mockEntries);
      expect(useDiaryStore.getState().totals).toEqual(mockTotals);
    });

    it('should set loading to false after loading completes', async () => {
      mockDiaryRepo.getEntriesByDate.mockResolvedValue([]);
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });

      const store = useDiaryStore.getState();
      await store.loadEntries('2025-02-06');

      expect(useDiaryStore.getState().loading).toBe(false);
    });

    it('should handle error and reset to initial state', async () => {
      const error = new Error('Database error');
      mockDiaryRepo.getEntriesByDate.mockRejectedValue(error);

      const store = useDiaryStore.getState();
      await store.loadEntries('2025-02-06');

      const state = useDiaryStore.getState();
      expect(state.entries).toEqual([]);
      expect(state.totals).toEqual({
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });
      expect(state.loading).toBe(false);
    });
  });

  describe('addEntry', () => {
    it('should add an entry and refresh the list', async () => {
      const mockTotals: NutrientTotals = {
        calories: 310,
        protein: 26,
        carbs: 2,
        fat: 22,
      };

      mockDiaryRepo.addEntry.mockResolvedValue({
        id: 2,
        food_id: 2,
        date: '2025-02-06',
        meal_type: 'lunch',
        quantity: 2,
        created_at: '2025-02-06T12:00:00Z',
      });
      mockDiaryRepo.getEntriesByDate.mockResolvedValue([]);
      mockDiaryRepo.getDailyTotals.mockResolvedValue(mockTotals);

      const store = useDiaryStore.getState();
      store.selectedDate = '2025-02-06';

      await store.addEntry(2, 'lunch' as MealType, 2);

      expect(mockDiaryRepo.addEntry).toHaveBeenCalledWith({
        food_id: 2,
        date: '2025-02-06',
        meal_type: 'lunch',
        quantity: 2,
      });
      expect(mockDiaryRepo.getEntriesByDate).toHaveBeenCalledWith('2025-02-06');
    });

    it('should update state with new totals after adding entry', async () => {
      const mockTotals: NutrientTotals = {
        calories: 310,
        protein: 26,
        carbs: 2,
        fat: 22,
      };

      mockDiaryRepo.addEntry.mockResolvedValue({
        id: 1,
        food_id: 1,
        date: '2025-02-06',
        meal_type: 'breakfast',
        quantity: 2,
        created_at: '2025-02-06T08:00:00Z',
      });
      mockDiaryRepo.getEntriesByDate.mockResolvedValue([]);
      mockDiaryRepo.getDailyTotals.mockResolvedValue(mockTotals);

      const store = useDiaryStore.getState();
      store.selectedDate = '2025-02-06';

      await store.addEntry(1, 'breakfast' as MealType, 2);

      expect(useDiaryStore.getState().totals).toEqual(mockTotals);
    });

    it('should set loading to false after adding entry', async () => {
      mockDiaryRepo.addEntry.mockResolvedValue({
        id: 1,
        food_id: 1,
        date: '2025-02-06',
        meal_type: 'breakfast',
        quantity: 1,
        created_at: '2025-02-06T08:00:00Z',
      });
      mockDiaryRepo.getEntriesByDate.mockResolvedValue([]);
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });

      const store = useDiaryStore.getState();
      store.selectedDate = '2025-02-06';

      await store.addEntry(1, 'breakfast' as MealType, 1);

      expect(useDiaryStore.getState().loading).toBe(false);
    });

    it('should throw error if add entry fails', async () => {
      const error = new Error('Failed to add entry');
      mockDiaryRepo.addEntry.mockRejectedValue(error);

      const store = useDiaryStore.getState();
      store.selectedDate = '2025-02-06';

      await expect(store.addEntry(1, 'breakfast' as MealType, 1)).rejects.toThrow(error);
    });
  });

  describe('removeEntry', () => {
    it('should remove an entry and refresh list', async () => {
      mockDiaryRepo.deleteEntry.mockResolvedValue(undefined);
      mockDiaryRepo.getEntriesByDate.mockResolvedValue([]);
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });

      const store = useDiaryStore.getState();
      store.selectedDate = '2025-02-06';

      await store.removeEntry(1);

      expect(mockDiaryRepo.deleteEntry).toHaveBeenCalledWith(1);
      expect(mockDiaryRepo.getEntriesByDate).toHaveBeenCalledWith('2025-02-06');
    });

    it('should update totals after removing entry', async () => {
      const mockTotals: NutrientTotals = {
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      };

      mockDiaryRepo.deleteEntry.mockResolvedValue(undefined);
      mockDiaryRepo.getEntriesByDate.mockResolvedValue([]);
      mockDiaryRepo.getDailyTotals.mockResolvedValue(mockTotals);

      const store = useDiaryStore.getState();
      store.selectedDate = '2025-02-06';

      await store.removeEntry(1);

      expect(useDiaryStore.getState().totals).toEqual(mockTotals);
    });
  });

  describe('refreshTotals', () => {
    it('should refresh daily totals', async () => {
      const mockTotals: NutrientTotals = {
        calories: 500,
        protein: 30,
        carbs: 50,
        fat: 20,
      };

      mockDiaryRepo.getDailyTotals.mockResolvedValue(mockTotals);

      const store = useDiaryStore.getState();
      store.selectedDate = '2025-02-06';

      await store.refreshTotals();

      expect(mockDiaryRepo.getDailyTotals).toHaveBeenCalledWith('2025-02-06');
      expect(useDiaryStore.getState().totals).toEqual(mockTotals);
    });

    it('should throw error if refresh fails', async () => {
      const error = new Error('Failed to refresh totals');
      mockDiaryRepo.getDailyTotals.mockRejectedValue(error);

      const store = useDiaryStore.getState();
      await expect(store.refreshTotals()).rejects.toThrow(error);
    });
  });

  describe('initial state', () => {
    it('should have correct initial values', () => {
      const store = useDiaryStore.getState();

      expect(store.selectedDate).toBeDefined();
      expect(store.entries).toEqual([]);
      expect(store.totals).toEqual({
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });
      expect(store.loading).toBe(false);
    });
  });
});
