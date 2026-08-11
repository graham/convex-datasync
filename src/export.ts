import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.ts";

export interface ExportOptions {
  outDir: string;
  format: "jsonl" | "json";
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
    let content: string;
    if (options.format === "json") {
      content = JSON.stringify([...docs], null, 2) + "\n";
    } else {
      let lines = "";
      for (const doc of docs) {
        lines += JSON.stringify(doc) + "\n";
      }
      content = lines;
    }
    writeFileSync(path, content);
    console.log(`${path}: ${stat.documents} document(s)`);
  }
}
