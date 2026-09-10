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
  collect,
  type DataStore,
  type PageStats,
  type StoreOptions,
  type SyncState,
  type TableChange,
  type TableStat,
} from "./datastore.ts";
export { DeltaLogStore, foldQuery } from "./deltalog.ts";
export {
  EXPORT_FORMATS,
  exportPath,
  isExportFormat,
  runExport,
  tableKey,
  type ExportFormat,
  type ExportOptions,
  type TableRef,
} from "./export.ts";
export {
  ROOT_COMPONENT_ALIAS,
  buildSelection,
  needsRootTables,
  parseColumnFilter,
  parseComponentFilter,
  parseTableFilter,
  tableMatches,
  type ColumnFilter,
  type ComponentFilter,
  type SelectionInput,
  type TableFilter,
} from "./filter.ts";
export { runDryRun } from "./inspect.ts";
export { writeParquetFile } from "./parquet.ts";
export { Store } from "./store.ts";
export { runSync, type SyncOptions } from "./sync.ts";
export { columnValue, deriveColumns, type Column, type ColumnType } from "./tabular.ts";
