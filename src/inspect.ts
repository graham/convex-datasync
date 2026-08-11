// Dry run: report which tables appear to have more (or less) data on the
// server than in the local copy, without downloading any documents. Uses the
// same per-table document counts the dashboard shows.

import type { DataSyncClient } from "./api.ts";
import { tableMatches, type TableFilter } from "./filter.ts";
import type { Store } from "./store.ts";

const COUNT_CONCURRENCY = 8;

export async function runDryRun(
  client: DataSyncClient,
  store: Store,
  filter: TableFilter | null,
): Promise<void> {
  console.log("dry run: comparing server document counts to the local copy\n");
  const serverTables = await client.listRootTables();

  const selected = serverTables.filter((t) => filter === null || tableMatches(t, filter));
  const skipped = serverTables.filter((t) => filter !== null && !tableMatches(t, filter));

  const counts = new Map<string, number>();
  for (let i = 0; i < selected.length; i += COUNT_CONCURRENCY) {
    const batch = selected.slice(i, i + COUNT_CONCURRENCY);
    const sizes = await Promise.all(batch.map((t) => client.tableSize(t)));
    batch.forEach((t, j) => counts.set(t, sizes[j] as number));
  }

  const local = new Map<string, number>();
  const localComponents: { component: string; table: string; documents: number }[] = [];
  for (const stat of store.tableStats()) {
    if (stat.component === "") {
      local.set(stat.table, stat.documents);
    } else {
      localComponents.push(stat);
    }
  }

  const width = Math.max(
    5,
    ...serverTables.map((t) => t.length),
    ...localComponents.map((s) => s.component.length + s.table.length + 1),
  );
  const pad = (s: string) => s.padEnd(width);
  const num = (n: number | string) => String(n).padStart(8);
  console.log(`${pad("table")} ${num("server")} ${num("local")} ${num("delta")}`);

  let behind = 0;
  for (const table of selected) {
    const server = counts.get(table) ?? 0;
    const localCount = local.get(table) ?? 0;
    const delta = server - localCount;
    const notes: string[] = [];
    if (!local.has(table) && server > 0) {
      notes.push("not synced yet");
    }
    if (delta !== 0) {
      behind++;
    }
    console.log(
      `${pad(table)} ${num(server)} ${num(localCount)} ${num(delta > 0 ? `+${delta}` : delta)}` +
        (notes.length > 0 ? `  ${notes.join(", ")}` : ""),
    );
  }
  for (const table of skipped) {
    console.log(`${pad(table)} ${num("-")} ${num(local.get(table) ?? 0)} ${num("-")}  skipped by filter`);
  }
  for (const [table, documents] of local) {
    if (!serverTables.includes(table)) {
      console.log(`${pad(table)} ${num(0)} ${num(documents)} ${num(-documents)}  no longer on server`);
    }
  }
  for (const stat of localComponents) {
    console.log(
      `${pad(`${stat.component}/${stat.table}`)} ${num("?")} ${num(stat.documents)} ${num("?")}  component tables are not comparable`,
    );
  }

  console.log(
    behind === 0
      ? "\ndocument counts match for every compared table"
      : `\n${behind} table(s) differ; run sync to catch up`,
  );
  console.log(
    "note: counts cannot detect in-place updates, and a table can match counts while " +
      "having changed documents; sync is the source of truth",
  );
}
