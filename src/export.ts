import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toCsv } from "./csv.ts";
import { collect, type DataStore } from "./datastore.ts";
import { writeParquetFile } from "./parquet.ts";

export const EXPORT_FORMATS = ["jsonl", "json", "csv", "parquet"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export interface TableRef {
  component: string;
  table: string;
}

export interface ExportOptions {
  outDir: string;
  format: ExportFormat;
  // Write only these tables, leaving the rest of the output directory alone.
  // Omit to write every synced table.
  tables?: readonly TableRef[];
  // Where progress lines go; defaults to console.log. Sync passes its own so
  // the lines interleave with the progress bar instead of corrupting it.
  log?: (line: string) => void;
}

export function tableKey(ref: TableRef): string {
  return `${ref.component}\0${ref.table}`;
}

// <outDir>/<componentPath>/<table>.<format>; root component tables go
// directly in <outDir>.
export function exportPath(outDir: string, format: ExportFormat, ref: TableRef): string {
  const dir = ref.component ? join(outDir, ...ref.component.split("/")) : outDir;
  return join(dir, `${ref.table}.${format}`);
}

// Dumps synced tables to flat files, one per table, in the requested format.
export async function runExport(store: DataStore, options: ExportOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const stats = await store.tableStats();
  const counts = new Map(stats.map((stat) => [tableKey(stat), stat.documents]));
  // An explicit table list is written as given: a table emptied by a truncate
  // or by deletions is gone from tableStats(), and skipping it would leave its
  // file holding rows the deployment no longer has.
  const targets: readonly TableRef[] = options.tables ?? stats;
  if (targets.length === 0) {
    log("nothing to export; run sync first");
    return;
  }
  for (const target of targets) {
    const documents = counts.get(tableKey(target)) ?? 0;
    const path = exportPath(options.outDir, options.format, target);
    mkdirSync(dirname(path), { recursive: true });
    // Every format needs the whole table anyway: csv and parquet to derive
    // columns from it, json to nest it in an array.
    const docs = await collect(store.readTable(target.component, target.table));
    if (options.format === "parquet") {
      writeParquetFile(path, docs);
    } else if (options.format === "csv") {
      writeFileSync(path, toCsv(docs));
    } else if (options.format === "json") {
      writeFileSync(path, JSON.stringify(docs, null, 2) + "\n");
    } else {
      let lines = "";
      for (const doc of docs) {
        lines += JSON.stringify(doc) + "\n";
      }
      writeFileSync(path, lines);
    }
    log(`${path}: ${documents} document(s)`);
  }
}
