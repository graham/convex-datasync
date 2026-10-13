// The contract sync, export and status are written against, so the
// synced data can live either in SQLite (random-access, the default) or in an
// append-only log of parquet deltas.

import type { DataSyncResponse } from "./api.ts";

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

export interface DataStore {
  // Applies one page of changes together with its cursor. Must be atomic: a
  // half-applied page would leave the cursor pointing at data that was never
  // stored, which the next run would then skip. Stays synchronous because it
  // runs in the sync loop's hot path, and both backends write synchronously.
  applyPage(page: DataSyncResponse): PageStats;
  getState(): SyncState;
  reset(): void;
  // Reads are async because the parquet backend has to decode files to answer
  // them; SQLite answers synchronously and just wraps the result.
  tableStats(): Promise<TableStat[]>;
  // Live documents in _id order; pass includeDeleted to also get tombstoned
  // ones (their last-synced value, or just _id if never synced).
  readTable(
    component: string,
    table: string,
    includeDeleted?: boolean,
  ): AsyncIterable<Record<string, unknown>>;
  close(): void;
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) {
    out.push(item);
  }
  return out;
}
