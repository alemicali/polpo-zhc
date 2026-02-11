# SQLite Database Layer

Complete database implementation for the Calorie Counter app using expo-sqlite.

## Structure

```
src/
├── types/
│   └── index.ts          # TypeScript interfaces (Food, DiaryEntry, DailyGoals, etc.)
├── database/
│   ├── schema.ts         # Table definitions and migrations
│   ├── db.ts             # Database initialization and singleton
│   └── repositories/
│       ├── foodRepository.ts   # Food CRUD operations
│       ├── diaryRepository.ts  # Diary entry operations
│       └── goalsRepository.ts  # Daily goals management
```

## Database Schema

### foods
- `id` (INTEGER PK) - Auto-increment primary key
- `name` (TEXT) - Food name
- `calories` (REAL) - Calories per serving
- `protein` (REAL) - Protein in grams
- `carbs` (REAL) - Carbohydrates in grams
- `fat` (REAL) - Fat in grams
- `serving_size` (TEXT) - Serving size description
- `barcode` (TEXT, nullable) - Product barcode for scanning
- `is_custom` (INTEGER, default 1) - Boolean: user-created vs database food
- `created_at` (TEXT) - ISO timestamp

### diary_entries
- `id` (INTEGER PK) - Auto-increment primary key
- `food_id` (INTEGER FK) - References foods(id), CASCADE delete
- `date` (TEXT) - ISO date format (YYYY-MM-DD)
- `meal_type` (TEXT) - One of: breakfast, lunch, dinner, snack
- `quantity` (REAL, default 1) - Serving multiplier
- `created_at` (TEXT) - ISO timestamp

### daily_goals
- `id` (INTEGER PK) - Always 1 (singleton)
- `calories` (REAL, default 2000)
- `protein` (REAL, default 50)
- `carbs` (REAL, default 250)
- `fat` (REAL, default 65)

## Usage

### Initialization

```typescript
import { initDatabase } from './database/db';

// Initialize on app startup
await initDatabase();
```

### Food Repository

```typescript
import * as foodRepo from './database/repositories/foodRepository';

// Add a custom food
const pizza = await foodRepo.addFood({
  name: 'Pizza Margherita',
  calories: 266,
  protein: 11,
  carbs: 33,
  fat: 10,
  serving_size: '1 slice (100g)',
  barcode: null,
  is_custom: true,
});

// Search foods
const results = await foodRepo.searchFoods('pizza');

// Get by ID
const food = await foodRepo.getFoodById(1);

// Get recent foods
const recent = await foodRepo.getRecentFoods(10);

// Get by barcode
const scanned = await foodRepo.getFoodByBarcode('8001234567890');

// Update food
await foodRepo.updateFood(1, { calories: 270 });

// Delete food
await foodRepo.deleteFood(1);
```

### Diary Repository

```typescript
import * as diaryRepo from './database/repositories/diaryRepository';

// Add diary entry
const entry = await diaryRepo.addEntry({
  food_id: 1,
  date: '2024-02-06',
  meal_type: 'lunch',
  quantity: 2,
});

// Get entries for a date (with food details)
const entries = await diaryRepo.getEntriesByDate('2024-02-06');

// Get entries grouped by meal
const grouped = await diaryRepo.getEntriesByDateGrouped('2024-02-06');
// Returns: { breakfast: [], lunch: [], dinner: [], snack: [] }

// Update entry quantity
await diaryRepo.updateEntryQuantity(1, 1.5);

// Delete entry
await diaryRepo.deleteEntry(1);

// Get daily nutrient totals
const totals = await diaryRepo.getDailyTotals('2024-02-06');
// Returns: { calories: 1850, protein: 95, carbs: 180, fat: 65 }

// Get meal totals
const lunchTotals = await diaryRepo.getMealTotals('2024-02-06', 'lunch');

// Get date range of entries
const { minDate, maxDate } = await diaryRepo.getDateRange();

// Get all dates with entries (for calendar)
const dates = await diaryRepo.getDatesWithEntries();
```

### Goals Repository

```typescript
import * as goalsRepo from './database/repositories/goalsRepository';

// Get current goals
const goals = await goalsRepo.getGoals();

// Update goals
await goalsRepo.updateGoals({
  calories: 2200,
  protein: 120,
});

// Reset to defaults
await goalsRepo.resetGoalsToDefaults();

// Calculate progress
const progress = goalsRepo.calculateProgress(totals, goals);
// Returns: { calories: 92.5, protein: 95, carbs: 72, fat: 100 } (percentages)
```

## Features

- **Type Safety**: Full TypeScript support with proper interfaces
- **Error Handling**: All operations include try-catch with meaningful errors
- **Transactions**: Migration runs in transaction with rollback on failure
- **Indexes**: Optimized queries with appropriate indexes
- **Foreign Keys**: Enabled with CASCADE delete for referential integrity
- **Default Values**: Sensible defaults for all nullable/optional fields
- **Boolean Conversion**: SQLite integers converted to TypeScript booleans
- **Validation**: Input validation (e.g., positive quantities, valid meal types)

## Migration System

The database uses a version-based migration system:
- Current version stored in `PRAGMA user_version`
- Migrations run automatically on `initDatabase()`
- Each migration wrapped in transaction
- Schema version tracked in `schema.ts`

To add a new migration:
1. Increment `SCHEMA_VERSION` in `schema.ts`
2. Add migration logic in `runMigrations()` in `db.ts`
3. Wrap in `if (fromVersion < newVersion)` block

## Best Practices

1. **Always initialize first**: Call `initDatabase()` before any DB operations
2. **Use repositories**: Don't access `getDatabase()` directly in app code
3. **Handle errors**: All repository functions can throw errors
4. **Validate inputs**: Check data before passing to repositories
5. **Use types**: Import and use TypeScript interfaces from `types/index.ts`
6. **Date format**: Always use ISO format (YYYY-MM-DD) for dates
7. **Quantities**: Use `quantity` field to scale nutrients (e.g., 2 servings)

## Performance Notes

- Indexes on frequently queried columns (date, food_id, name, barcode)
- `getEntriesByDate` joins and sorts efficiently with CASE ordering
- `searchFoods` uses LIKE with prefix optimization
- `getRecentFoods` uses JOIN to filter to actually-used foods
- All aggregate queries use COALESCE to handle null sums
