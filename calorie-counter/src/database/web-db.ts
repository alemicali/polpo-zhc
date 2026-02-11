import initSqlJs, { Database } from 'sql.js';

/**
 * Web-compatible SQLite implementation using sql.js (WASM)
 * Mimics the expo-sqlite async API surface for compatibility
 */

interface RunResult {
  lastInsertRowId: number;
  changes: number;
}

export class WebSQLiteDatabase {
  private db: Database | null = null;
  private sqlJs: any = null;

  async init(): Promise<void> {
    if (this.db) return;

    // Initialize sql.js with WASM
    this.sqlJs = await initSqlJs({
      // Load WASM from CDN
      locateFile: (file) => `https://sql.js.org/dist/${file}`
    });

    // Try to load existing database from localStorage
    const savedDb = localStorage.getItem('calorie-counter-db');
    if (savedDb) {
      try {
        const buffer = this.base64ToBuffer(savedDb);
        this.db = new this.sqlJs.Database(buffer);
      } catch (error) {
        console.warn('Failed to load saved database, creating new one:', error);
        this.db = new this.sqlJs.Database();
      }
    } else {
      this.db = new this.sqlJs.Database();
    }
  }

  /**
   * Save database to localStorage
   */
  private saveToStorage(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const base64 = this.bufferToBase64(data);
      localStorage.setItem('calorie-counter-db', base64);
    } catch (error) {
      console.error('Failed to save database to localStorage:', error);
    }
  }

  private bufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToBuffer(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Execute SQL without returning results (for CREATE, INSERT, UPDATE, DELETE)
   */
  async execAsync(sql: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.exec(sql);
      this.saveToStorage();
    } catch (error) {
      console.error('SQL exec error:', error);
      throw error;
    }
  }

  /**
   * Run SQL and return metadata (for INSERT, UPDATE, DELETE)
   */
  async runAsync(sql: string, params: any[] = []): Promise<RunResult> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.run(sql, params);

      // Get last insert row ID if it was an INSERT
      let lastInsertRowId = 0;
      if (sql.trim().toUpperCase().startsWith('INSERT')) {
        const result = this.db.exec('SELECT last_insert_rowid() as id');
        if (result.length > 0 && result[0].values.length > 0) {
          lastInsertRowId = result[0].values[0][0] as number;
        }
      }

      // Get number of changes
      const changesResult = this.db.exec('SELECT changes() as changes');
      let changes = 0;
      if (changesResult.length > 0 && changesResult[0].values.length > 0) {
        changes = changesResult[0].values[0][0] as number;
      }

      this.saveToStorage();

      return {
        lastInsertRowId,
        changes
      };
    } catch (error) {
      console.error('SQL run error:', error);
      throw error;
    }
  }

  /**
   * Get all rows matching the query
   */
  async getAllAsync<T>(sql: string, params: any[] = []): Promise<T[]> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);

      const rows: T[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject();
        rows.push(row as T);
      }
      stmt.free();

      return rows;
    } catch (error) {
      console.error('SQL getAllAsync error:', error);
      throw error;
    }
  }

  /**
   * Get the first row matching the query
   */
  async getFirstAsync<T>(sql: string, params: any[] = []): Promise<T | null> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);

      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row as T;
      }

      stmt.free();
      return null;
    } catch (error) {
      console.error('SQL getFirstAsync error:', error);
      throw error;
    }
  }

  /**
   * Close the database connection
   */
  async closeAsync(): Promise<void> {
    if (this.db) {
      this.saveToStorage();
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Open a web-compatible database
 */
export async function openDatabaseAsync(name: string): Promise<WebSQLiteDatabase> {
  const db = new WebSQLiteDatabase();
  await db.init();
  return db;
}
