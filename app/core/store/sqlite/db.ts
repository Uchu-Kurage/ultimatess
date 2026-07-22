// ============================================================================
// SQLite 接続とマイグレーション実行 (P1 M0 / §5)。
// better-sqlite3 は同期 API・高速。WAL でクラッシュ耐性を高める。
// ============================================================================

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

export function openDatabase(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  runMigrations(db);
  return db;
}

/** migrations ディレクトリの .sql を昇順に適用（適用済みは schema_migrations で管理）。 */
export function runMigrations(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER)`,
  );
  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied = new Set<string>(
    db.prepare(`SELECT name FROM schema_migrations`).all().map((r: any) => r.name as string),
  );
  const insert = db.prepare(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`);
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(file, Date.now());
    })();
  }
}

function migrationsDir(): string {
  // dist 実行時と ts 実行時の双方でマイグレーションを見つける。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../migrations'), // app/core/store/sqlite -> app/migrations
    path.resolve(here, '../../../../app/migrations'),
    path.resolve(process.cwd(), 'app/migrations'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('migrations ディレクトリが見つかりません');
}
