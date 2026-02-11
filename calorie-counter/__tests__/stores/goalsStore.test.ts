import { useGoalsStore } from '../../src/stores/goalsStore';
import * as goalsRepo from '../../src/database/repositories/goalsRepository';
import type { DailyGoals } from '../../src/types';

// Mock the repository
jest.mock('../../src/database/repositories/goalsRepository');

const mockGoalsRepo = goalsRepo as jest.Mocked<typeof goalsRepo>;

describe('useGoalsStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGoalsStore.setState({
      goals: null,
      loading: false,
    });
  });

  describe('loadGoals', () => {
    it('should set loading to true when loading starts', () => {
      mockGoalsRepo.getGoals.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  id: 1,
                  calories: 2000,
                  protein: 50,
                  carbs: 250,
                  fat: 65,
                }),
              1000
            );
          })
      );

      const store = useGoalsStore.getState();
      store.loadGoals();

      expect(useGoalsStore.getState().loading).toBe(true);
    });

    it('should load goals from repository', async () => {
      const mockGoals: DailyGoals = {
        id: 1,
        calories: 2000,
        protein: 50,
        carbs: 250,
        fat: 65,
      };

      mockGoalsRepo.getGoals.mockResolvedValue(mockGoals);

      const store = useGoalsStore.getState();
      await store.loadGoals();

      expect(mockGoalsRepo.getGoals).toHaveBeenCalled();
      expect(useGoalsStore.getState().goals).toEqual(mockGoals);
    });

    it('should set loading to false after loading completes', async () => {
      const mockGoals: DailyGoals = {
        id: 1,
        calories: 2000,
        protein: 50,
        carbs: 250,
        fat: 65,
      };

      mockGoalsRepo.getGoals.mockResolvedValue(mockGoals);

      const store = useGoalsStore.getState();
      await store.loadGoals();

      expect(useGoalsStore.getState().loading).toBe(false);
    });

    it('should handle error gracefully', async () => {
      const error = new Error('Database error');
      mockGoalsRepo.getGoals.mockRejectedValue(error);

      const store = useGoalsStore.getState();
      await store.loadGoals();

      const state = useGoalsStore.getState();
      expect(state.goals).toBe(null);
      expect(state.loading).toBe(false);
    });
  });

  describe('updateGoals', () => {
    it('should update goals with new values', async () => {
      const updatedGoals: DailyGoals = {
        id: 1,
        calories: 2500,
        protein: 60,
        carbs: 300,
        fat: 80,
      };

      mockGoalsRepo.updateGoals.mockResolvedValue(updatedGoals);

      const store = useGoalsStore.getState();
      await store.updateGoals({
        calories: 2500,
        protein: 60,
        carbs: 300,
        fat: 80,
      });

      expect(mockGoalsRepo.updateGoals).toHaveBeenCalledWith({
        calories: 2500,
        protein: 60,
        carbs: 300,
        fat: 80,
      });
      expect(useGoalsStore.getState().goals).toEqual(updatedGoals);
    });

    it('should update only partial goals', async () => {
      const updatedGoals: DailyGoals = {
        id: 1,
        calories: 2500,
        protein: 50,
        carbs: 250,
        fat: 65,
      };

      mockGoalsRepo.updateGoals.mockResolvedValue(updatedGoals);

      const store = useGoalsStore.getState();
      await store.updateGoals({ calories: 2500 });

      expect(mockGoalsRepo.updateGoals).toHaveBeenCalledWith({ calories: 2500 });
      expect(useGoalsStore.getState().goals).toEqual(updatedGoals);
    });

    it('should set loading to false after update completes', async () => {
      const updatedGoals: DailyGoals = {
        id: 1,
        calories: 2000,
        protein: 50,
        carbs: 250,
        fat: 65,
      };

      mockGoalsRepo.updateGoals.mockResolvedValue(updatedGoals);

      const store = useGoalsStore.getState();
      await store.updateGoals({ calories: 2000 });

      expect(useGoalsStore.getState().loading).toBe(false);
    });

    it('should throw error if update fails', async () => {
      const error = new Error('Failed to update goals');
      mockGoalsRepo.updateGoals.mockRejectedValue(error);

      const store = useGoalsStore.getState();

      await expect(store.updateGoals({ calories: 2000 })).rejects.toThrow(error);
    });

    it('should keep loading false on error', async () => {
      const error = new Error('Failed to update goals');
      mockGoalsRepo.updateGoals.mockRejectedValue(error);

      const store = useGoalsStore.getState();

      try {
        await store.updateGoals({ calories: 2000 });
      } catch {
        // error expected
      }

      expect(useGoalsStore.getState().loading).toBe(false);
    });

    it('should update multiple goals at once', async () => {
      const updatedGoals: DailyGoals = {
        id: 1,
        calories: 2500,
        protein: 100,
        carbs: 300,
        fat: 80,
      };

      mockGoalsRepo.updateGoals.mockResolvedValue(updatedGoals);

      const store = useGoalsStore.getState();
      await store.updateGoals({
        calories: 2500,
        protein: 100,
        carbs: 300,
        fat: 80,
      });

      expect(mockGoalsRepo.updateGoals).toHaveBeenCalledWith({
        calories: 2500,
        protein: 100,
        carbs: 300,
        fat: 80,
      });
      expect(useGoalsStore.getState().goals).toEqual(updatedGoals);
    });
  });

  describe('initial state', () => {
    it('should have correct initial values', () => {
      const store = useGoalsStore.getState();

      expect(store.goals).toBe(null);
      expect(store.loading).toBe(false);
    });
  });
});
