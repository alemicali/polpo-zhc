export const SCHEMA_VERSION = 1;

export const CREATE_TABLES = `
  -- Foods table
  CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fat REAL NOT NULL,
    serving_size TEXT NOT NULL,
    barcode TEXT,
    is_custom INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Diary entries table
  CREATE TABLE IF NOT EXISTS diary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    food_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    meal_type TEXT NOT NULL CHECK(meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    quantity REAL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE CASCADE
  );

  -- Daily goals table
  CREATE TABLE IF NOT EXISTS daily_goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    calories REAL DEFAULT 2000,
    protein REAL DEFAULT 50,
    carbs REAL DEFAULT 250,
    fat REAL DEFAULT 65
  );

  -- Indexes for better query performance
  CREATE INDEX IF NOT EXISTS idx_diary_entries_date ON diary_entries(date);
  CREATE INDEX IF NOT EXISTS idx_diary_entries_food_id ON diary_entries(food_id);
  CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name);
  CREATE INDEX IF NOT EXISTS idx_foods_barcode ON foods(barcode) WHERE barcode IS NOT NULL;
`;

export const SEED_DEFAULT_GOALS = `
  INSERT OR IGNORE INTO daily_goals (id, calories, protein, carbs, fat)
  VALUES (1, 2000, 50, 250, 65);
`;
