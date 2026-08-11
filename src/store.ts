// Local SQLite store for synced documents plus sync state (cursor, syncId).
// Each page from the API is applied in a single transaction together with its
// cursor, as the API requires: truncates first, then values in order.

import { DatabaseSync } from "node:sqlite";
import { consistentTs, type DataSyncResponse } from "./api.ts";

// syncedTs is kept as a string: Convex timestamps are int64 nanoseconds,
// which exceed Number.MAX_SAFE_INTEGER (node:sqlite refuses to read such
// values as numbers).
export interface SyncState {
  cursor: string | null;
  syncId: string | null;
  syncedTs: string | null;
  statusType: string | null;
  updatedAt: number | null;
}

export interface TableStat {
  component: string;
  table: string;
  documents: number;
  deletedDocuments: number;
}

export interface StoreOptions {
  // Keep rows for deleted documents, marking them with a `deleted` flag and
  // preserving their last-synced value, instead of removing them. Tombstones
  // from the API carry only `_id`, so the stored value is left untouched.
  keepDeleted?: boolean;
}

export interface TableChange {
  component: string;
  table: string;
  upserted: number;
  deleted: number;
}

export interface PageStats {
  truncated: { component: string; table: string }[];
  upserted: number;
  deleted: number;
  perTable: TableChange[];
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly keepDeleted: boolean;

  constructor(path: string, options: StoreOptions = {}) {
    this.keepDeleted = options.keepDeleted ?? false;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        component TEXT NOT NULL,
        tbl TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        value TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (component, tbl, doc_id)
      );
      CREATE TABLE IF NOT EXISTS sync_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor TEXT,
        sync_id TEXT,
        synced_ts INTEGER,
        status_type TEXT,
        updated_at INTEGER
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "deleted")) {
      this.db.exec("ALTER TABLE documents ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
    }
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  applyPage(page: DataSyncResponse): PageStats {
    const stats: PageStats = { truncated: [], upserted: 0, deleted: 0, perTable: [] };
    const changes = new Map<string, TableChange>();
    const changeFor = (component: string, table: string): TableChange => {
      const key = `${component}\0${table}`;
      let change = changes.get(key);
      if (!change) {
        change = { component, table, upserted: 0, deleted: 0 };
        changes.set(key, change);
      }
      return change;
    };

    const truncate = this.db.prepare(
      "DELETE FROM documents WHERE component = ? AND tbl = ?",
    );
    const upsert = this.db.prepare(
      `INSERT INTO documents (component, tbl, doc_id, ts, value, deleted)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT (component, tbl, doc_id)
       DO UPDATE SET ts = excluded.ts, value = excluded.value, deleted = 0`,
    );
    const remove = this.db.prepare(
      "DELETE FROM documents WHERE component = ? AND tbl = ? AND doc_id = ?",
    );
    const markDeleted = this.db.prepare(
      "UPDATE documents SET deleted = 1, ts = ? WHERE component = ? AND tbl = ? AND doc_id = ?",
    );
    const insertTombstone = this.db.prepare(
      `INSERT INTO documents (component, tbl, doc_id, ts, value, deleted)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    const saveState = this.db.prepare(
      `INSERT INTO sync_state (singleton, cursor, sync_id, synced_ts, status_type, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET
         cursor = excluded.cursor,
         sync_id = excluded.sync_id,
         synced_ts = excluded.synced_ts,
         status_type = excluded.status_type,
         updated_at = excluded.updated_at`,
    );

    this.transaction(() => {
      for (const t of page.truncates) {
        truncate.run(t.component, t.table);
        stats.truncated.push({ component: t.component, table: t.table });
      }
      for (const v of page.values) {
        const id = v.value._id;
        if (typeof id !== "string") {
          throw new Error(
            `document in ${v.component || "<root>"}/${v.table} has no string _id`,
          );
        }
        if (v.deleted) {
          if (this.keepDeleted) {
            const result = markDeleted.run(String(v.ts), v.component, v.table, id);
            if (result.changes === 0) {
              // Tombstone for a document we never synced; record the fact of
              // its deletion with the only field the API provides (_id).
              insertTombstone.run(v.component, v.table, id, String(v.ts), JSON.stringify(v.value));
            }
          } else {
            remove.run(v.component, v.table, id);
          }
          stats.deleted++;
          changeFor(v.component, v.table).deleted++;
        } else {
          upsert.run(v.component, v.table, id, String(v.ts), JSON.stringify(v.value));
          stats.upserted++;
          changeFor(v.component, v.table).upserted++;
        }
      }
      const ts = consistentTs(page.status);
      saveState.run(
        page.pagination.nextCursor ?? null,
        page.syncId,
        ts === null ? null : String(ts),
        page.status.type,
        Date.now(),
      );
    });
    stats.perTable = [...changes.values()];
    return stats;
  }

  getState(): SyncState {
    // CAST in SQL so databases written before the string migration (holding
    // int64 values) never materialize as JS numbers.
    const row = this.db
      .prepare(
        `SELECT cursor, sync_id, CAST(synced_ts AS TEXT) AS synced_ts, status_type, updated_at
         FROM sync_state WHERE singleton = 1`,
      )
      .get() as
      | {
          cursor: string | null;
          sync_id: string | null;
          synced_ts: string | null;
          status_type: string | null;
          updated_at: number | null;
        }
      | undefined;
    return {
      cursor: row?.cursor ?? null,
      syncId: row?.sync_id ?? null,
      syncedTs: row?.synced_ts ?? null,
      statusType: row?.status_type ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  reset(): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM documents; DELETE FROM sync_state;");
    });
  }

  tableStats(): TableStat[] {
    return this.db
      .prepare(
        `SELECT component, tbl AS "table",
                SUM(CASE WHEN deleted = 0 THEN 1 ELSE 0 END) AS documents,
                SUM(CASE WHEN deleted = 1 THEN 1 ELSE 0 END) AS deletedDocuments
         FROM documents GROUP BY component, tbl ORDER BY component, tbl`,
      )
      .all() as unknown as TableStat[];
  }

  // Yields live documents; pass includeDeleted to also get tombstoned rows
  // (their last-synced value, with only `_id` for never-synced tombstones).
  *readTable(
    component: string,
    table: string,
    includeDeleted = false,
  ): Generator<Record<string, unknown>> {
    const rows = this.db
      .prepare(
        `SELECT value FROM documents
         WHERE component = ? AND tbl = ? AND (? = 1 OR deleted = 0)
         ORDER BY doc_id`,
      )
      .iterate(component, table, includeDeleted ? 1 : 0) as IterableIterator<{ value: string }>;
    for (const row of rows) {
      yield JSON.parse(row.value) as Record<string, unknown>;
    }
  }

  close(): void {
    this.db.close();
  }
}
