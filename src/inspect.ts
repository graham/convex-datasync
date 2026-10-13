// Dry run: show what a sync with the given flags would cover, and how far the
// local copy is from the deployment, without downloading a single document.
//
// Uses the per-table document counts the dashboard shows. That query is not
// part of the documented data sync API (see DataSyncClient.systemQuery), which
// is why this is a separate command: the sync itself never depends on it.

import type { DataSyncClient } from "./api.ts";
import type { TableStat } from "./datastore.ts";
import {
  ROOT_COMPONENT_ALIAS,
  tableMatches,
  type ColumnFilter,
  type ComponentFilter,
  type TableFilter,
} from "./selection.ts";

const COUNT_CONCURRENCY = 8;

export interface DryRunScope {
  tables: string[] | null;
  tableFilter: TableFilter | null;
  components: ComponentFilter | null;
  columns: ColumnFilter | null;
}

// Whether the root component is part of what the flags select, mirroring how
// the selection itself is built: naming root tables puts the root in, and
// otherwise it follows the component lists.
function rootInScope(scope: DryRunScope): boolean {
  if (scope.components?.exclude?.has(ROOT_COMPONENT_ALIAS)) {
    return false;
  }
  const namesRootTables =
    scope.tables !== null || scope.tableFilter !== null || (scope.columns?.byTable.size ?? 0) > 0;
  return (
    namesRootTables ||
    !scope.components?.include ||
    scope.components.include.has(ROOT_COMPONENT_ALIAS)
  );
}

export async function runDryRun(
  client: DataSyncClient,
  local: TableStat[],
  scope: DryRunScope,
  // Called with the deployment's tables before anything is reported, so a
  // dry run refuses exactly what the real sync would refuse.
  validate: (serverTables: string[]) => void = () => {},
  log: (line: string) => void = (line) => console.log(line),
): Promise<void> {
  const serverTables = await client.listRootTables();
  validate(serverTables);
  log("dry run: nothing is downloaded or written\n");
  const inScope = rootInScope(scope);

  let selected: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  if (inScope) {
    if (scope.tables !== null) {
      selected = scope.tables.filter((t) => serverTables.includes(t));
      missing.push(...scope.tables.filter((t) => !serverTables.includes(t)));
      skipped.push(...serverTables.filter((t) => !scope.tables!.includes(t)));
    } else {
      for (const table of serverTables) {
        (scope.tableFilter === null || tableMatches(table, scope.tableFilter) ? selected : skipped).push(
          table,
        );
      }
    }
  } else {
    skipped.push(...serverTables);
  }

  const counts = new Map<string, number>();
  for (let i = 0; i < selected.length; i += COUNT_CONCURRENCY) {
    const batch = selected.slice(i, i + COUNT_CONCURRENCY);
    const sizes = await Promise.all(batch.map((t) => client.tableSize(t)));
    batch.forEach((t, j) => counts.set(t, sizes[j] as number));
  }

  const localRoot = new Map<string, number>();
  const localComponents: TableStat[] = [];
  for (const stat of local) {
    if (stat.component === "") {
      localRoot.set(stat.table, stat.documents);
    } else {
      localComponents.push(stat);
    }
  }

  // What the flags select, before the comparison.
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  log("scope:");
  log(`  root tables:  ${selected.length} of ${serverTables.length}, ${total} document(s)`);
  if (skipped.length > 0) {
    const shown = skipped.slice(0, 8).join(", ");
    const more = skipped.length > 8 ? `, and ${skipped.length - 8} more` : "";
    log(`  skipped:      ${skipped.length} table(s): ${shown}${more}`);
  }
  if (missing.length > 0) {
    log(`  not on the deployment: ${missing.join(", ")}`);
  }
  if (scope.components?.include) {
    log(`  components:   only ${[...scope.components.include].join(", ")}`);
  }
  if (scope.components?.exclude) {
    log(`  components:   skipping ${[...scope.components.exclude].join(", ")}`);
  }
  if (!scope.components?.include && !scope.components?.exclude) {
    log("  components:   all (their tables cannot be counted, only synced)");
  }
  if (scope.columns) {
    const named = [
      ...scope.columns.all,
      ...[...scope.columns.byTable].flatMap(([t, c]) => [...c].map((n) => `${t}:${n}`)),
    ];
    log(`  columns:      ${scope.columns.mode === "include" ? "keeping only" : "dropping"} ${named.join(", ")}`);
  }
  log("");

  const width = Math.max(5, ...serverTables.map((t) => t.length), ...localComponents.map((s) => s.component.length + s.table.length + 1));
  const pad = (s: string) => s.padEnd(width);
  const num = (n: number | string) => String(n).padStart(8);
  log(`${pad("table")} ${num("server")} ${num("local")} ${num("delta")}`);

  let behind = 0;
  for (const table of selected) {
    const server = counts.get(table) ?? 0;
    const localCount = localRoot.get(table) ?? 0;
    const delta = server - localCount;
    if (delta !== 0) {
      behind++;
    }
    const note = !localRoot.has(table) && server > 0 ? "  not synced yet" : "";
    log(`${pad(table)} ${num(server)} ${num(localCount)} ${num(delta > 0 ? `+${delta}` : delta)}${note}`);
  }
  // A skipped table matters in the comparison only if the local copy still
  // holds some of it; the scope above already names the ones simply not wanted.
  for (const table of skipped) {
    const held = localRoot.get(table) ?? 0;
    if (held > 0) {
      log(`${pad(table)} ${num("-")} ${num(held)} ${num("-")}  outside the selection, kept locally`);
    }
  }
  for (const [table, documents] of localRoot) {
    if (!serverTables.includes(table)) {
      log(`${pad(table)} ${num(0)} ${num(documents)} ${num(-documents)}  no longer on the deployment`);
    }
  }
  for (const stat of localComponents) {
    log(`${pad(`${stat.component}/${stat.table}`)} ${num("?")} ${num(stat.documents)} ${num("?")}  component tables are not comparable`);
  }

  log(
    behind === 0
      ? "\ndocument counts match for every compared table"
      : `\n${behind} table(s) differ; run sync to catch up`,
  );
  log(
    "note: counts cannot detect in-place updates, and a table can match counts while " +
      "having changed documents; sync is the source of truth",
  );
}
