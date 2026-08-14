#!/usr/bin/env node
import { existsSync, renameSync } from "node:fs";
import { parseArgs } from "node:util";
import { DataSyncClient } from "./api.ts";
import { loadEnvFiles, localDeploymentName, resolveConnection } from "./config.ts";
import { EXPORT_FORMATS, isExportFormat, runExport } from "./export.ts";
import { parseTableFilter, selectionFromFilter, tableMatches } from "./filter.ts";
import { runDryRun } from "./inspect.ts";
import { Store } from "./store.ts";
import { runSync, selectionForTables } from "./sync.ts";

const USAGE = `datasync - incremental Convex deployment data sync

Usage:
  datasync sync [options]     fetch pages until caught up (resumes from saved cursor)
  datasync dry-run [options]  compare server vs local document counts, download nothing
  datasync status             show local sync state and per-table counts
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
  --db <path>          sqlite database path (default: <deployment-name>.sqlite3)
  --tables <a,b,c>     only sync these root-component tables (default: everything)
  --include-tables <re>  only sync root tables whose name matches this regex
  --exclude-tables <re>  skip root tables whose name matches this regex
                         (--ignore-tables is an alias; e.g. --exclude-tables="^auth")
  --keep-deleted       keep rows for deleted documents (marked with a deleted
                       flag, last-synced value preserved) instead of removing them
  --fresh              discard local data and cursor, restart sync from scratch
  --watch              keep polling for new writes instead of exiting when caught up
  --interval <secs>    poll interval in watch mode after catching up (default: 60)
  --max-pages <n>      stop after n pages (progress saved; rerun to continue)
  --debug              log every page including empty ones, with cursor fingerprints
  --out <dir>          export output directory (default: export)
  --format <fmt>       export format: jsonl, json, csv or parquet (default: jsonl)
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
      tables: { type: "string" },
      "include-tables": { type: "string" },
      "exclude-tables": { type: "string" },
      "ignore-tables": { type: "string" },
      "keep-deleted": { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      interval: { type: "string", default: "60" },
      out: { type: "string", default: "export" },
      format: { type: "string", default: "jsonl" },
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

  // status/export are offline; the prod deployment's name is only known
  // after a network call, so require an explicit target for them.
  const offlineDbPath = (): string => {
    if (values.prod && values.db === undefined) {
      fail("--prod with status/export needs --db <path> or --deployment <name>");
    }
    return dbPathFor(
      localDeploymentName({
        url: values.url as string | undefined,
        deployment: values.deployment as string | undefined,
      }),
    );
  };

  if (command === "status") {
    const dbPath = offlineDbPath();
    const store = new Store(dbPath);
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
      for (const stat of store.tableStats()) {
        const deleted = stat.deletedDocuments > 0 ? ` (+${stat.deletedDocuments} deleted)` : "";
        console.log(`${stat.component || "<root>"}/${stat.table}: ${stat.documents}${deleted}`);
      }
    } finally {
      store.close();
    }
    return;
  }

  if (command === "export") {
    const format = values.format as string;
    if (!isExportFormat(format)) {
      fail(`unknown format: ${format} (expected ${EXPORT_FORMATS.join(", ")})`);
    }
    const store = new Store(offlineDbPath());
    try {
      await runExport(store, { outDir: values.out as string, format });
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
    const dbPath = dbPathFor(connection.deploymentName);
    if (existsSync(dbPath)) {
      const store = new Store(dbPath);
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

  const filter = parseTableFilter(
    values["include-tables"] as string | undefined,
    (values["exclude-tables"] as string | undefined) ??
      (values["ignore-tables"] as string | undefined),
  );
  if (filter && values.tables) {
    fail("--tables cannot be combined with --include-tables/--exclude-tables");
  }

  if (command === "dry-run") {
    const store = new Store(dbPathFor(connection.deploymentName));
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
  let selection = values.tables
    ? selectionForTables(
        (values.tables as string)
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
      )
    : undefined;
  if (filter) {
    const rootTables = await client.listRootTables();
    const included = rootTables.filter((t) => tableMatches(t, filter));
    const excluded = rootTables.filter((t) => !tableMatches(t, filter));
    if (included.length === 0) {
      fail("table filter matches no tables on the deployment");
    }
    console.log(`syncing ${included.length} table(s): ${included.join(", ")}`);
    if (excluded.length > 0) {
      console.log(`skipping ${excluded.length} table(s): ${excluded.join(", ")}`);
    }
    selection = selectionFromFilter(rootTables, filter);
  }

  const store = new Store(dbPathFor(connection.deploymentName), {
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
    });
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
