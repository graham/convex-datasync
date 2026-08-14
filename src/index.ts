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
export { toCsv } from "./csv.ts";
export {
  EXPORT_FORMATS,
  isExportFormat,
  runExport,
  type ExportFormat,
  type ExportOptions,
} from "./export.ts";
export { writeParquetFile } from "./parquet.ts";
export { columnValue, deriveColumns, type Column, type ColumnType } from "./tabular.ts";
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
