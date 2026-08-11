// Library entry point.

export {
  ApiError,
  DataSyncClient,
  consistentTs,
  isCaughtUp,
  type ActiveDataSync,
  type DataSyncArgs,
  type DataSyncResponse,
  type DataSyncStatus,
  type DataSyncValue,
  type Selection,
} from "./api.ts";
export { resolveConnection, type Connection, type ConnectionFlags } from "./config.ts";
export { runExport, type ExportOptions } from "./export.ts";
export { parseTableFilter, selectionFromFilter, tableMatches, type TableFilter } from "./filter.ts";
export { runDryRun } from "./inspect.ts";
export {
  Store,
  type PageStats,
  type StoreOptions,
  type SyncState,
  type TableStat,
} from "./store.ts";
export { runSync, selectionForTables, type SyncOptions } from "./sync.ts";
