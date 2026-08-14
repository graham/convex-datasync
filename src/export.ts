import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toCsv } from "./csv.ts";
import { writeParquetFile } from "./parquet.ts";
import type { Store } from "./store.ts";

export const EXPORT_FORMATS = ["jsonl", "json", "csv", "parquet"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

export interface ExportOptions {
  outDir: string;
  format: ExportFormat;
}

// Writes each synced table to <outDir>/<componentPath>/<table>.<format>.
// Root component tables go directly in <outDir>.
export async function runExport(store: Store, options: ExportOptions): Promise<void> {
  const stats = store.tableStats();
  if (stats.length === 0) {
    console.log("nothing to export; run sync first");
    return;
  }
  for (const stat of stats) {
    const dir = stat.component
      ? join(options.outDir, ...stat.component.split("/"))
      : options.outDir;
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${stat.table}.${options.format}`);
    const docs = store.readTable(stat.component, stat.table);
    if (options.format === "parquet") {
      writeParquetFile(path, docs);
    } else if (options.format === "csv") {
      writeFileSync(path, toCsv(docs));
    } else if (options.format === "json") {
      writeFileSync(path, JSON.stringify([...docs], null, 2) + "\n");
    } else {
      let lines = "";
      for (const doc of docs) {
        lines += JSON.stringify(doc) + "\n";
      }
      writeFileSync(path, lines);
    }
    console.log(`${path}: ${stat.documents} document(s)`);
  }
}
