import * as diaryRepo from '../database/repositories/diaryRepository';
import type { NutrientTotals } from '../types';

export interface DailyStats extends NutrientTotals {
  date: string;
}

/**
 * Get daily totals for the last N days from a given date
 */
export async function getWeeklyStats(
  referenceDate: Date,
  days: number = 7
): Promise<DailyStats[]> {
  const stats: DailyStats[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(referenceDate);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD format

    try {
      const totals = await diaryRepo.getDailyTotals(dateStr);
      stats.push({
        date: dateStr,
        ...totals,
      });
    } catch (error) {
      console.error(`Error getting stats for ${dateStr}:`, error);
      // Include the date with zero totals on error
      stats.push({
        date: dateStr,
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
      });
    }
  }

  return stats;
}

/**
 * Calculate average daily calories for a set of daily stats
 */
export function calculateAverageCalories(stats: DailyStats[]): number {
  if (stats.length === 0) return 0;

  const total = stats.reduce((sum, day) => sum + day.calories, 0);
  return Math.round(total / stats.length);
}

/**
 * Format date to Italian locale (e.g., "lun 3" for Monday 3rd)
 */
export function formatDateItalian(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00:00'); // Prevent timezone issues
  const days = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
  const dayName = days[date.getDay()];
  const dayNum = date.getDate();
  return `${dayName} ${dayNum}`;
}
