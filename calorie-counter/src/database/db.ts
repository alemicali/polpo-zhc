import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { CREATE_TABLES, SEED_DEFAULT_GOALS, SCHEMA_VERSION } from './schema';
import { seedDefaultFoods } from './seeds';
import { openDatabaseAsync as openWebDatabase, WebSQLiteDatabase } from './web-db';

// Union type to handle both native and web databases
type DatabaseInstance = SQLite.SQLiteDatabase | WebSQLiteDatabase;

let database: DatabaseInstance | null = null;

/**
 * Initialize the SQLite database and run migrations
 */
export async function initDatabase(): Promise<DatabaseInstance> {
  if (database) {
    return database;
  }

  try {
    // Use web-compatible database for web platform, native for others
    if (Platform.OS === 'web') {
      console.log('Initializing web database (sql.js)...');
      database = await openWebDatabase('calorie-counter.db');
    } else {
      console.log('Initializing native database (expo-sqlite)...');
      database = await SQLite.openDatabaseAsync('calorie-counter.db');
    }

    // Enable foreign keys
    await database.execAsync('PRAGMA foreign_keys = ON;');

    // Check schema version
    const result = await database.getFirstAsync<{ user_version: number }>(
      'PRAGMA user_version;'
    );
    const currentVersion = result?.user_version ?? 0;

    // Run migrations if needed
    if (currentVersion < SCHEMA_VERSION) {
      await runMigrations(database, currentVersion);
    }

    return database;
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Run database migrations
 */
async function runMigrations(
  db: DatabaseInstance,
  fromVersion: number
): Promise<void> {
  console.log(`Running migrations from version ${fromVersion} to ${SCHEMA_VERSION}`);

  try {
    await db.execAsync('BEGIN TRANSACTION;');

    if (fromVersion < 1) {
      // Initial schema
      await db.execAsync(CREATE_TABLES);
      await db.execAsync(SEED_DEFAULT_GOALS);
      // Seed default Italian foods
      await seedDefaultFoods(db);
    }

    // Set the new schema version
    await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    await db.execAsync('COMMIT;');

    console.log('Migrations completed successfully');
  } catch (error) {
    await db.execAsync('ROLLBACK;');
    console.error('Migration failed:', error);
    throw error;
  }
}

/**
 * Get the database instance (must be initialized first)
 */
export function getDatabase(): DatabaseInstance {
  if (!database) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return database;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (database) {
    await database.closeAsync();
    database = null;
  }
}
