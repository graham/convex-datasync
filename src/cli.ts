#!/usr/bin/env node
import { existsSync, renameSync } from "node:fs";
import { parseArgs } from "node:util";
import { DataSyncClient } from "./api.ts";
import { loadEnvFiles, localDeploymentName, resolveConnection } from "./config.ts";
import type { DataStore } from "./datastore.ts";
import { DeltaLogStore } from "./deltalog.ts";
import { EXPORT_FORMATS, isExportFormat, runExport } from "./export.ts";
import {
  buildSelection,
  needsRootTables,
  parseColumnFilter,
  parseComponentFilter,
  parseTableFilter,
  tableMatches,
} from "./filter.ts";
import { runDryRun } from "./inspect.ts";
import { Store, type StoreOptions } from "./store.ts";
import { runSync } from "./sync.ts";

const USAGE = `datasync - incremental Convex deployment data sync

Usage:
  datasync sync [options]     fetch pages until caught up (resumes from saved cursor),
                                writing sqlite plus --format files if given
  datasync dry-run [options]  compare server vs local document counts, download nothing
  datasync status             show local sync state and per-table counts
                                (--remote also asks the deployment for its view)
  datasync list               list live data syncs on the deployment
                                 (active-syncs is an alias)
  datasync export [options]   dump synced tables to files

Running datasync with no command runs sync.

Credentials are resolved from, in order:
  1. --url + --deploy-key (or env CONVEX_URL + CONVEX_DEPLOY_KEY)
  2. a Convex project directory: CONVEX_DEPLOYMENT from .env.local plus your
     'npx convex login' session (~/.convex/config.json)

Options:
  --url <url>          deployment url (default: env CONVEX_URL)
  --deploy-key <key>   deploy key (default: env CONVEX_DEPLOY_KEY)
  --prod               target the current project's prod deployment
  --deployment <name>  target a specific deployment by name (bare or prefixed)
  --store <kind>       where synced data lives: sqlite (default) or log, an
                       append-only log of parquet deltas plus cursor.json
  --db <path>          sqlite database path (default: <deployment-name>.sqlite3)
  --log-dir <dir>      delta log directory for --store log
                       (default: <deployment-name>.deltalog)
  --tables <a,b,c>     only sync these root-component tables (default: everything)
  --include-tables <re>  only sync root tables whose name matches this regex
  --exclude-tables <re>  skip root tables whose name matches this regex
                         (--ignore-tables is an alias; e.g. --exclude-tables="^auth")
  --components <a,b,c>   only sync these components (_root names the root one)
  --exclude-components <a,b,c>  skip these components
  --include-columns <spec>  keep only these columns of each root table; entries
                         are 'column' (every table) or 'table:column'. _id is
                         always kept
  --exclude-columns <spec>  drop these columns instead, same spec syntax
                         (e.g. --exclude-columns youtubeVideos:description)
  --keep-deleted       keep rows for deleted documents (marked with a deleted
                       flag, last-synced value preserved) instead of removing them
  --fresh              discard local data and cursor, restart sync from scratch
  --fresh-export       rewrite every --format file, including tables this run
                       did not change (once per run, not once per watch poll)
  --watch              keep polling for new writes instead of exiting when caught up
  --interval <secs>    poll interval in watch mode after catching up (default: 60)
  --max-pages <n>      stop after n pages (progress saved; rerun to continue)
  --debug              log every page including empty ones, with cursor fingerprints
  --out <dir>          export output directory (default: export)
  --format <fmt>       output format: jsonl, json, csv or parquet. On export it
                       picks the dump format (default: jsonl). On sync it also
                       keeps files in that format up to date next to the
                       sqlite mirror; without it sync writes sqlite only.
  --help               show this help
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  loadEnvFiles();
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      url: { type: "string" },
      "deploy-key": { type: "string" },
      prod: { type: "boolean", default: false },
      deployment: { type: "string" },
      db: { type: "string" },
      store: { type: "string", default: "sqlite" },
      "log-dir": { type: "string" },
      tables: { type: "string" },
      "include-tables": { type: "string" },
      "exclude-tables": { type: "string" },
      "ignore-tables": { type: "string" },
      components: { type: "string" },
      "exclude-components": { type: "string" },
      "include-columns": { type: "string" },
      "exclude-columns": { type: "string" },
      remote: { type: "boolean", default: false },
      "keep-deleted": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      "fresh-export": { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      interval: { type: "string", default: "60" },
      out: { type: "string", default: "export" },
      format: { type: "string" },
      "max-pages": { type: "string" },
      debug: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const command = positionals[0] ?? "sync";
  if (values.help || command === "help") {
    console.log(USAGE);
    return;
  }

  // --format is optional everywhere: export falls back to jsonl, sync writes
  // no files at all unless it is given.
  const requestedFormat = values.format as string | undefined;
  if (requestedFormat !== undefined && !isExportFormat(requestedFormat)) {
    fail(`unknown format: ${requestedFormat} (expected ${EXPORT_FORMATS.join(", ")})`);
  }
  if (requestedFormat !== undefined && !["sync", "export"].includes(command)) {
    fail(`--format has no effect on ${command}; it applies to sync and export`);
  }
  const freshExport = values["fresh-export"] as boolean;
  if (freshExport && command !== "sync") {
    // export always rewrites every table anyway, so the flag would be a no-op.
    fail(
      command === "export"
        ? "--fresh-export has no effect on export; it already rewrites every table"
        : `--fresh-export has no effect on ${command}; it applies to sync`,
    );
  }
  if (freshExport && requestedFormat === undefined) {
    fail("--fresh-export needs --format <fmt>; without it sync writes no files to refresh");
  }

  const remote = values.remote as boolean;
  if (remote && command !== "status") {
    fail(`--remote has no effect on ${command}; it applies to status`);
  }
  const selectionFlags = {
    components: values.components,
    "exclude-components": values["exclude-components"],
    "include-columns": values["include-columns"],
    "exclude-columns": values["exclude-columns"],
  };
  for (const [flag, value] of Object.entries(selectionFlags)) {
    if (value !== undefined && command !== "sync") {
      fail(`--${flag} has no effect on ${command}; it applies to sync`);
    }
  }

  // Parsed before any network work so a bad pattern or column spec fails
  // immediately rather than after credentials are resolved.
  let filter;
  let componentFilter;
  let columnFilter;
  try {
    filter = parseTableFilter(
      values["include-tables"] as string | undefined,
      (values["exclude-tables"] as string | undefined) ??
        (values["ignore-tables"] as string | undefined),
    );
    componentFilter = parseComponentFilter(
      values.components as string | undefined,
      values["exclude-components"] as string | undefined,
    );
    columnFilter = parseColumnFilter(
      values["include-columns"] as string | undefined,
      values["exclude-columns"] as string | undefined,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (filter && values.tables) {
    fail("--tables cannot be combined with --include-tables/--exclude-tables");
  }

  const storeKind = values.store as string;
  if (storeKind !== "sqlite" && storeKind !== "log") {
    fail(`unknown store: ${storeKind} (expected sqlite or log)`);
  }
  if (storeKind === "log" && values.db !== undefined) {
    fail("--db is for --store sqlite; --store log uses --log-dir");
  }
  if (storeKind === "sqlite" && values["log-dir"] !== undefined) {
    fail("--log-dir is for --store log; --store sqlite uses --db");
  }

  // Default db name: <deployment-name>.sqlite3 (first label of the
  // deployment's hostname). Only when --db is not given do we also migrate a
  // db from the old default name.
  const dbPathFor = (deploymentName: string | null): string => {
    if (values.db !== undefined) {
      return values.db as string;
    }
    const dbPath = `${deploymentName ?? "datasync"}.sqlite3`;
    if (!existsSync(dbPath) && existsSync("quickexport.db")) {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(`quickexport.db${suffix}`)) {
          renameSync(`quickexport.db${suffix}`, `${dbPath}${suffix}`);
        }
      }
      console.log(`renamed quickexport.db to ${dbPath}`);
    }
    return dbPath;
  };

  const logDirFor = (deploymentName: string | null): string =>
    (values["log-dir"] as string | undefined) ?? `${deploymentName ?? "datasync"}.deltalog`;

  // Where this deployment's data lives, in whichever backend is selected.
  const storePathFor = (deploymentName: string | null): string =>
    storeKind === "log" ? logDirFor(deploymentName) : dbPathFor(deploymentName);

  const openStore = (deploymentName: string | null, options: StoreOptions = {}): DataStore =>
    storeKind === "log"
      ? new DeltaLogStore(logDirFor(deploymentName), options)
      : new Store(dbPathFor(deploymentName), options);

  // status/export are offline; the prod deployment's name is only known
  // after a network call, so require an explicit target for them.
  const offlineDeployment = (): string | null => {
    const explicit = storeKind === "log" ? values["log-dir"] : values.db;
    if (values.prod && explicit === undefined) {
      fail(
        `--prod with status/export needs ${storeKind === "log" ? "--log-dir <dir>" : "--db <path>"} or --deployment <name>`,
      );
    }
    return localDeploymentName({
      url: values.url as string | undefined,
      deployment: values.deployment as string | undefined,
    });
  };

  if (command === "status") {
    const store = openStore(offlineDeployment());
    try {
      const state = store.getState();
      if (state.syncId === null) {
        console.log("no sync state; run sync first");
        return;
      }
      console.log(`syncId:    ${state.syncId}`);
      console.log(`status:    ${state.statusType}`);
      console.log(`syncedTs:  ${state.syncedTs ?? "n/a"}`);
      console.log(`updated:   ${state.updatedAt ? new Date(state.updatedAt).toISOString() : "n/a"}`);
      for (const stat of await store.tableStats()) {
        const deleted = stat.deletedDocuments > 0 ? ` (+${stat.deletedDocuments} deleted)` : "";
        console.log(`${stat.component || "<root>"}/${stat.table}: ${stat.documents}${deleted}`);
      }
      if (remote) {
        const connection = await resolveConnection({
          url: values.url as string | undefined,
          deployKey: values["deploy-key"] as string | undefined,
          deployment: values.deployment as string | undefined,
          prod: values.prod as boolean,
        });
        const sync = await new DataSyncClient(connection.url, connection.deployKey).getActiveSync(
          state.syncId,
        );
        console.log();
        if (sync === null) {
          console.log(
            `server: sync ${state.syncId} is no longer active (a sync expires 3 days after its`,
          );
          console.log("        last page; run sync --fresh to start over)");
        } else {
          const s = sync.status;
          const progress =
            s.currentTable !== undefined
              ? `, currently ${s.currentComponent || "<root>"}/${s.currentTable} ` +
                `(table ${(s.numTablesSynced ?? 0) + 1}/${s.totalTables ?? "?"})`
              : "";
          console.log(
            `server: ${s.type}, ${s.numDocumentsSynced ?? 0}/${s.totalDocuments ?? "?"} docs${progress}`,
          );
          console.log(`        last page ${new Date(sync.lastUpdated).toISOString()}`);
        }
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "export") {
    const store = openStore(offlineDeployment());
    try {
      await runExport(store, {
        outDir: values.out as string,
        format: requestedFormat ?? "jsonl",
      });
    } finally {
      store.close();
    }
    return;
  }

  const connection = await resolveConnection({
    url: values.url as string | undefined,
    deployKey: values["deploy-key"] as string | undefined,
    deployment: values.deployment as string | undefined,
    prod: values.prod as boolean,
  });
  const client = new DataSyncClient(connection.url, connection.deployKey);

  if (command === "list" || command === "active-syncs") {
    const response = await client.listActiveSyncs();
    if (response.syncs.length === 0) {
      console.log("no active syncs");
      return;
    }
    // Mark the sync this machine's database is following, if any.
    let localSyncId: string | null = null;
    if (existsSync(storePathFor(connection.deploymentName))) {
      const store = openStore(connection.deploymentName);
      try {
        localSyncId = store.getState().syncId;
      } finally {
        store.close();
      }
    }
    for (const sync of response.syncs) {
      const updated = new Date(sync.lastUpdated).toISOString();
      const s = sync.status;
      const ts = s.snapshotTs ?? s.syncedTs;
      const mine = sync.syncId === localSyncId ? "  <- this database" : "";
      if (s.currentTable !== undefined) {
        console.log(
          `${sync.syncId}: ${s.type}, ${s.numTablesSynced ?? 0}/${s.totalTables ?? "?"} tables, ` +
            `${s.numDocumentsSynced ?? 0}/${s.totalDocuments ?? "?"} docs ` +
            `(currently ${s.currentComponent || "<root>"}/${s.currentTable}), updated ${updated}${mine}`,
        );
      } else {
        console.log(
          `${sync.syncId}: ${s.type}${ts !== undefined ? ` at ts ${ts}` : ""}, ` +
            `${s.numDocumentsSynced ?? 0} docs, updated ${updated}${mine}`,
        );
      }
    }
    return;
  }

  if (command === "dry-run") {
    const store = openStore(connection.deploymentName);
    try {
      await runDryRun(client, store, filter);
    } finally {
      store.close();
    }
    return;
  }

  if (command !== "sync") {
    fail(`unknown command: ${command}\n\n${USAGE}`);
  }

  const intervalSeconds = Number(values.interval);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    fail(`invalid --interval: ${values.interval}`);
  }
  let maxPages: number | undefined;
  if (values["max-pages"] !== undefined) {
    maxPages = Number(values["max-pages"]);
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      fail(`invalid --max-pages: ${values["max-pages"]}`);
    }
  }
  const tables = values.tables
    ? (values.tables as string)
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : null;
  const selectionInput = {
    tables,
    tableFilter: filter,
    components: componentFilter,
    columns: columnFilter,
  };
  // Regex table filters and column filters both have to name every table in
  // the selection, so they need the deployment's table list first.
  let rootTables: string[] | null = null;
  if (needsRootTables(selectionInput)) {
    rootTables = await client.listRootTables();
    if (filter) {
      const included = rootTables.filter((t) => tableMatches(t, filter));
      const excluded = rootTables.filter((t) => !tableMatches(t, filter));
      if (included.length === 0) {
        fail("table filter matches no tables on the deployment");
      }
      console.log(`syncing ${included.length} table(s): ${included.join(", ")}`);
      if (excluded.length > 0) {
        console.log(`skipping ${excluded.length} table(s): ${excluded.join(", ")}`);
      }
    }
  }
  const selection = buildSelection({ ...selectionInput, rootTables });
  if (columnFilter) {
    const scope = columnFilter.mode === "include" ? "keeping only" : "dropping";
    const named = [
      ...columnFilter.all,
      ...[...columnFilter.byTable].flatMap(([t, c]) => [...c].map((n) => `${t}:${n}`)),
    ];
    console.log(`${scope} column(s): ${named.join(", ")}`);
  }
  if (componentFilter?.include) {
    console.log(`syncing component(s): ${[...componentFilter.include].join(", ")}`);
  }
  if (componentFilter?.exclude) {
    console.log(`skipping component(s): ${[...componentFilter.exclude].join(", ")}`);
  }

  const store = openStore(connection.deploymentName, {
    keepDeleted: values["keep-deleted"] as boolean,
  });
  try {
    if (values.fresh) {
      console.log("discarding local data and cursor");
      store.reset();
    }
    await runSync(client, store, {
      watch: values.watch as boolean,
      intervalSeconds,
      selection,
      maxPages,
      debug: values.debug as boolean,
      exportTo:
        requestedFormat === undefined
          ? undefined
          : { outDir: values.out as string, format: requestedFormat, fresh: freshExport },
    });
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
