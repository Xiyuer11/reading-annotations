import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { AnnotationRecord } from './types';

type SqlJsStatic = Awaited<ReturnType<typeof initSqlJs>>;
type SqlJsDatabase = InstanceType<SqlJsStatic['Database']>;

function rowToAnnotation(columns: string[], values: unknown[]): AnnotationRecord {
  const row: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i += 1) {
    row[columns[i]] = values[i];
  }

  return {
    id: String(row.id),
    notePath: String(row.note_path),
    thought: String(row.thought),
    tags: JSON.parse(String(row.tags_json)),
    source: JSON.parse(String(row.source_json)),
    anchor: JSON.parse(String(row.anchor_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteIndexStore {
  private constructor(
    private readonly dbPath: string,
    private readonly db: SqlJsDatabase,
  ) {}

  static async open(dbPath: string): Promise<SqliteIndexStore> {
    const SQL = await initSqlJs();

    await mkdir(path.dirname(dbPath), { recursive: true });

    let db: SqlJsDatabase;
    try {
      const raw = await readFile(dbPath);
      db = new SQL.Database(new Uint8Array(raw));
    } catch {
      db = new SQL.Database();
    }

    const store = new SqliteIndexStore(dbPath, db);
    store.initializeSchema();
    await store.flush();
    return store;
  }

  private initializeSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        note_path TEXT NOT NULL,
        thought TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        anchor_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_annotations_note_updated ON annotations(note_path, updated_at DESC);',
    );
  }

  async upsert(annotation: AnnotationRecord): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO annotations (
        id, note_path, thought, tags_json, source_json, anchor_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        note_path = excluded.note_path,
        thought = excluded.thought,
        tags_json = excluded.tags_json,
        source_json = excluded.source_json,
        anchor_json = excluded.anchor_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at;
    `);

    stmt.run([
      annotation.id,
      annotation.notePath,
      annotation.thought,
      JSON.stringify(annotation.tags),
      JSON.stringify(annotation.source),
      JSON.stringify(annotation.anchor),
      annotation.createdAt,
      annotation.updatedAt,
    ]);
    stmt.free();

    await this.flush();
  }

  async delete(id: string): Promise<void> {
    const stmt = this.db.prepare('DELETE FROM annotations WHERE id = ?');
    stmt.run([id]);
    stmt.free();

    await this.flush();
  }

  async queryByNote(notePath: string, query: string): Promise<AnnotationRecord[]> {
    const trimmed = query.trim();
    const hasQuery = trimmed.length > 0;

    const sql = hasQuery
      ? `SELECT * FROM annotations
         WHERE note_path = ?
           AND (thought LIKE ? OR tags_json LIKE ? OR source_json LIKE ?)
         ORDER BY updated_at DESC`
      : `SELECT * FROM annotations
         WHERE note_path = ?
         ORDER BY updated_at DESC`;

    const values = hasQuery
      ? [notePath, `%${trimmed}%`, `%${trimmed}%`, `%${trimmed}%`]
      : [notePath];

    const stmt = this.db.prepare(sql);
    const rows: AnnotationRecord[] = [];

    stmt.bind(values);
    while (stmt.step()) {
      const rowValues = stmt.get();
      const columns = stmt.getColumnNames();
      rows.push(rowToAnnotation(columns, rowValues));
    }
    stmt.free();

    return rows;
  }

  async rebuildFromAnnotations(records: AnnotationRecord[]): Promise<void> {
    this.db.run('DELETE FROM annotations');

    for (const record of records) {
      await this.upsert(record);
    }

    await this.flush();
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }

  private async flush(): Promise<void> {
    const exported = this.db.export();
    await writeFile(this.dbPath, Buffer.from(exported));
  }
}
