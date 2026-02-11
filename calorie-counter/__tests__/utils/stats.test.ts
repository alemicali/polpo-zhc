import {
  getWeeklyStats,
  calculateAverageCalories,
  formatDateItalian,
  type DailyStats,
} from '../../src/utils/stats';
import * as diaryRepo from '../../src/database/repositories/diaryRepository';

// Mock the repository
jest.mock('../../src/database/repositories/diaryRepository');

const mockDiaryRepo = diaryRepo as jest.Mocked<typeof diaryRepo>;

describe('stats utility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getWeeklyStats', () => {
    it('should fetch daily totals for 7 days by default', async () => {
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 2000,
        protein: 100,
        carbs: 250,
        fat: 65,
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate);

      expect(stats).toHaveLength(7);
      expect(mockDiaryRepo.getDailyTotals).toHaveBeenCalledTimes(7);
    });

    it('should return stats for custom number of days', async () => {
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 1500,
        protein: 80,
        carbs: 200,
        fat: 50,
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 14);

      expect(stats).toHaveLength(14);
      expect(mockDiaryRepo.getDailyTotals).toHaveBeenCalledTimes(14);
    });

    it('should calculate correct dates going backwards', async () => {
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 2000,
        protein: 100,
        carbs: 250,
        fat: 65,
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 3);

      expect(stats).toHaveLength(3);
      expect(stats[0].date).toBe('2025-02-04');
      expect(stats[1].date).toBe('2025-02-05');
      expect(stats[2].date).toBe('2025-02-06');
    });

    it('should include all nutrient totals for each day', async () => {
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 2000,
        protein: 100,
        carbs: 250,
        fat: 65,
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 1);

      expect(stats[0]).toEqual({
        date: '2025-02-06',
        calories: 2000,
        protein: 100,
        carbs: 250,
        fat: 65,
      });
    });

    it('should handle errors gracefully and return zero totals', async () => {
      mockDiaryRepo.getDailyTotals.mockRejectedValueOnce(new Error('Database error'));
      mockDiaryRepo.getDailyTotals.mockResolvedValueOnce({
        calories: 1500,
        protein: 75,
        carbs: 200,
        fat: 50,
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 2);

      expect(stats).toHaveLength(2);
      expect(stats[0]).toEqual({
        date: '2025-02-05',
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });
      expect(stats[1]).toEqual({
        date: '2025-02-06',
        calories: 1500,
        protein: 75,
        carbs: 200,
        fat: 50,
      });
    });

    it('should handle all days with zero values', async () => {
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 7);

      expect(stats).toHaveLength(7);
      stats.forEach((day) => {
        expect(day.calories).toBe(0);
        expect(day.protein).toBe(0);
        expect(day.carbs).toBe(0);
        expect(day.fat).toBe(0);
      });
    });

    it('should handle varying calorie intake across days', async () => {
      const dailyTotals = [
        { calories: 1800, protein: 90, carbs: 220, fat: 60 },
        { calories: 2200, protein: 110, carbs: 280, fat: 70 },
        { calories: 1900, protein: 95, carbs: 240, fat: 65 },
      ];

      mockDiaryRepo.getDailyTotals.mockImplementation((date: string) => {
        const index = parseInt(date.split('-')[2]) - 4; // Map to our test data
        return Promise.resolve(dailyTotals[index] || { calories: 0, protein: 0, carbs: 0, fat: 0 });
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 3);

      expect(stats).toHaveLength(3);
      expect(stats[0].calories).toBeLessThanOrEqual(stats[1].calories);
    });
  });

  describe('calculateAverageCalories', () => {
    it('should calculate average of daily stats', () => {
      const stats: DailyStats[] = [
        { date: '2025-02-01', calories: 2000, protein: 100, carbs: 250, fat: 65 },
        { date: '2025-02-02', calories: 2100, protein: 105, carbs: 260, fat: 70 },
        { date: '2025-02-03', calories: 1900, protein: 95, carbs: 240, fat: 60 },
      ];

      const average = calculateAverageCalories(stats);

      expect(average).toBe(2000); // (2000 + 2100 + 1900) / 3 = 2000
    });

    it('should return 0 for empty stats array', () => {
      const average = calculateAverageCalories([]);

      expect(average).toBe(0);
    });

    it('should round the average correctly', () => {
      const stats: DailyStats[] = [
        { date: '2025-02-01', calories: 2000, protein: 100, carbs: 250, fat: 65 },
        { date: '2025-02-02', calories: 2001, protein: 100, carbs: 250, fat: 65 },
      ];

      const average = calculateAverageCalories(stats);

      expect(average).toBe(2001); // (2000 + 2001) / 2 = 2000.5 -> rounds to 2001
      expect(typeof average).toBe('number');
    });

    it('should handle single day', () => {
      const stats: DailyStats[] = [
        { date: '2025-02-01', calories: 2500, protein: 125, carbs: 300, fat: 80 },
      ];

      const average = calculateAverageCalories(stats);

      expect(average).toBe(2500);
    });

    it('should handle zero calorie days', () => {
      const stats: DailyStats[] = [
        { date: '2025-02-01', calories: 0, protein: 0, carbs: 0, fat: 0 },
        { date: '2025-02-02', calories: 0, protein: 0, carbs: 0, fat: 0 },
        { date: '2025-02-03', calories: 3000, protein: 150, carbs: 375, fat: 100 },
      ];

      const average = calculateAverageCalories(stats);

      expect(average).toBe(1000); // (0 + 0 + 3000) / 3 = 1000
    });

    it('should handle very large calorie values', () => {
      const stats: DailyStats[] = [
        { date: '2025-02-01', calories: 5000, protein: 250, carbs: 625, fat: 160 },
        { date: '2025-02-02', calories: 4500, protein: 225, carbs: 562, fat: 144 },
      ];

      const average = calculateAverageCalories(stats);

      expect(average).toBe(4750); // (5000 + 4500) / 2 = 4750
    });

    it('should return integer result', () => {
      const stats: DailyStats[] = [
        { date: '2025-02-01', calories: 1999, protein: 100, carbs: 250, fat: 65 },
        { date: '2025-02-02', calories: 2001, protein: 100, carbs: 250, fat: 65 },
      ];

      const average = calculateAverageCalories(stats);

      expect(Number.isInteger(average)).toBe(true);
    });
  });

  describe('formatDateItalian', () => {
    it('should format Monday correctly', () => {
      const formatted = formatDateItalian('2025-02-03'); // This is a Monday
      expect(formatted).toMatch(/lun \d+/);
    });

    it('should format Sunday correctly', () => {
      const formatted = formatDateItalian('2025-02-02'); // This is a Sunday
      expect(formatted).toMatch(/dom \d+/);
    });

    it('should format all weekdays', () => {
      const days = [
        { date: '2025-02-02', expected: 'dom 2' }, // Sunday
        { date: '2025-02-03', expected: 'lun 3' }, // Monday
        { date: '2025-02-04', expected: 'mar 4' }, // Tuesday
        { date: '2025-02-05', expected: 'mer 5' }, // Wednesday
        { date: '2025-02-06', expected: 'gio 6' }, // Thursday
        { date: '2025-02-07', expected: 'ven 7' }, // Friday
        { date: '2025-02-08', expected: 'sab 8' }, // Saturday
      ];

      days.forEach(({ date, expected }) => {
        const formatted = formatDateItalian(date);
        expect(formatted).toBe(expected);
      });
    });

    it('should include day number', () => {
      const formatted = formatDateItalian('2025-02-15');
      expect(formatted).toMatch(/\s15$/);
    });

    it('should handle single digit days', () => {
      const formatted = formatDateItalian('2025-02-05');
      expect(formatted).toMatch(/\s5$/);
    });

    it('should handle end of month dates', () => {
      const formatted = formatDateItalian('2025-02-28');
      expect(formatted).toMatch(/\s28$/);
    });

    it('should format different months', () => {
      const formatted1 = formatDateItalian('2025-01-15');
      const formatted2 = formatDateItalian('2025-12-15');

      expect(formatted1).toMatch(/\d+/);
      expect(formatted2).toMatch(/\d+/);
    });

    it('should handle leap year dates', () => {
      const formatted = formatDateItalian('2024-02-29');
      expect(formatted).toMatch(/\s29$/);
    });

    it('should return consistent format', () => {
      const formatted = formatDateItalian('2025-02-06');
      const parts = formatted.split(' ');

      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatch(/^[a-z]{3}$/); // 3-letter day abbreviation
      expect(parseInt(parts[1])).toBeGreaterThan(0); // Valid day number
    });
  });

  describe('integration tests', () => {
    it('should calculate average from weekly stats', async () => {
      mockDiaryRepo.getDailyTotals.mockImplementation((date: string) => {
        // Return different values based on the date
        const day = parseInt(date.split('-')[2]);
        return Promise.resolve({
          calories: 1500 + day * 50,
          protein: 75 + day * 2,
          carbs: 200 + day * 5,
          fat: 50 + day,
        });
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 7);
      const average = calculateAverageCalories(stats);

      expect(average).toBeGreaterThan(0);
      expect(Number.isInteger(average)).toBe(true);
    });

    it('should work with formatted dates', async () => {
      mockDiaryRepo.getDailyTotals.mockResolvedValue({
        calories: 2000,
        protein: 100,
        carbs: 250,
        fat: 65,
      });

      const referenceDate = new Date('2025-02-06');
      const stats = await getWeeklyStats(referenceDate, 3);

      const formattedDates = stats.map((s) => formatDateItalian(s.date));

      expect(formattedDates).toHaveLength(3);
      formattedDates.forEach((formatted) => {
        expect(formatted).toMatch(/^[a-z]{3} \d+$/);
      });
    });
  });
});
