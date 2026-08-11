import cliProgress from "cli-progress";
import { ApiError, DataSyncClient, isCaughtUp, type Selection } from "./api.ts";
import type { PageStats, Store } from "./store.ts";

export interface SyncOptions {
  watch: boolean;
  intervalSeconds: number;
  selection?: Selection;
  // Stop after this many pages (progress is saved; rerun to continue).
  maxPages?: number;
  // Log every page including empty ones, with cursor fingerprints.
  debug?: boolean;
}

// Short printable identity for an opaque cursor, to see whether it advances.
function cursorFingerprint(cursor: string | null): string {
  if (cursor === null) {
    return "<none>";
  }
  return `${cursor.length}ch ${cursor.slice(0, 12)}..${cursor.slice(-8)}`;
}

// How often to refresh totals from /data/list_active_syncs for the progress bar.
const TOTALS_REFRESH_MS = 5000;
// Log a heartbeat after this many consecutive pages with no changes.
const EMPTY_PAGE_LOG_EVERY = 100;

// Builds a selection that exports only the given tables of the root component,
// with all their columns.
export function selectionForTables(tables: string[]): Selection {
  const root: Record<string, { _other: "incl" }> = {};
  for (const table of tables) {
    root[table] = { _other: "incl" };
  }
  return {
    _other: "excl",
    "": { _other: "excl", ...root },
  };
}

function tableLabel(component: string, table: string): string {
  return component ? `${component}/${table}` : table;
}

function statusLabel(type: string): string {
  switch (type) {
    case "upToDate":
    case "synced":
      return "up to date";
    case "snapshotting":
    case "inProgress":
      return "snapshotting";
    case "stale":
      return "catching up";
    default:
      return type;
  }
}

function describeChanges(stats: PageStats): string {
  return stats.perTable
    .map((c) => {
      let s = tableLabel(c.component, c.table);
      if (c.upserted > 0) s += ` +${c.upserted}`;
      if (c.deleted > 0) s += ` -${c.deleted}`;
      return s;
    })
    .join(", ");
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish);
  });
}

export async function runSync(
  client: DataSyncClient,
  store: Store,
  options: SyncOptions,
): Promise<void> {
  let cursor = store.getState().cursor;
  console.log(cursor ? "resuming sync from saved cursor" : "starting sync from scratch");

  const interactive = process.stdout.isTTY === true;
  const multibar = interactive
    ? new cliProgress.MultiBar({
        format: "[{bar}] {percentage}% | {value}/{total} docs | page {page} | {detail}",
        barCompleteChar: "#",
        barIncompleteChar: "-",
        hideCursor: true,
        clearOnComplete: false,
        autopadding: true,
      })
    : null;
  const bar = multibar ? multibar.create(0, 0, { page: 0, detail: "starting" }) : null;
  const log = (line: string) => {
    if (multibar) {
      multibar.log(line + "\n");
    } else {
      console.log(line);
    }
  };

  // Every page is applied to SQLite in one transaction together with its
  // cursor, so interrupting between pages (or killing the process outright)
  // never loses or corrupts progress: the next run resumes from the last
  // fully-applied page. Ctrl-c aborts the in-flight fetch and exits cleanly;
  // a second ctrl-c force-quits.
  const cancel = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) {
      process.exit(130);
    }
    interrupted = true;
    log("interrupt received; finishing current page (ctrl-c again to force quit)");
    cancel.abort();
  };
  process.on("SIGINT", onSigint);

  let pages = 0;
  let upserted = 0;
  let deleted = 0;
  let emptyStreak = 0;
  let totalDocs = 0;
  let lastTotalsFetch = 0;
  let syncId: string | null = null;
  let lastDetail = "starting";

  const refreshTotals = async () => {
    if (!bar || syncId === null || Date.now() - lastTotalsFetch < TOTALS_REFRESH_MS) {
      return;
    }
    lastTotalsFetch = Date.now();
    try {
      const response = await client.listActiveSyncs(cancel.signal);
      const mine = response.syncs.find((s) => s.syncId === syncId);
      if (!mine) {
        return;
      }
      totalDocs = mine.status.totalDocuments ?? mine.status.numDocumentsSynced ?? totalDocs;
      if (mine.status.currentTable !== undefined) {
        lastDetail =
          `${tableLabel(mine.status.currentComponent ?? "", mine.status.currentTable)} ` +
          `(table ${(mine.status.numTablesSynced ?? 0) + 1}/${mine.status.totalTables ?? "?"})`;
      }
    } catch {
      // Totals are best-effort display data; never fail the sync over them.
    }
  };

  const flushEmptyStreak = () => {
    if (emptyStreak > 0) {
      log(`${emptyStreak} empty page(s) scanned (no matching changes)`);
      emptyStreak = 0;
    }
  };

  try {
    while (!interrupted) {
      let page;
      const fetchStart = Date.now();
      try {
        page = await client.fetchPage({ cursor, selection: options.selection }, cancel.signal);
      } catch (error) {
        if (interrupted) {
          break;
        }
        if (error instanceof ApiError && error.cursorExpired) {
          multibar?.stop();
          console.error(
            "the saved cursor has expired (syncs must run at least once every 3 days).",
          );
          console.error(
            "run again with --fresh to clear local data and restart from scratch.",
          );
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      const fetchMs = Date.now() - fetchStart;

      const applyStart = Date.now();
      const stats = store.applyPage(page);
      const applyMs = Date.now() - applyStart;

      pages++;
      upserted += stats.upserted;
      deleted += stats.deleted;
      const previousCursor = cursor;
      cursor = page.pagination.nextCursor ?? null;
      if (syncId !== null && syncId !== page.syncId) {
        log(`warning: syncId changed from ${syncId} to ${page.syncId} (server restarted the sync)`);
      }
      syncId = page.syncId;

      if (options.debug) {
        log(
          `debug page ${pages} | syncId ${page.syncId} | values ${page.values.length} ` +
            `truncates ${page.truncates.length} | hasMore ${page.pagination.hasMore} | ` +
            `status ${page.status.type} | fetch ${fetchMs}ms apply ${applyMs}ms | ` +
            `cursor ${cursorFingerprint(previousCursor)} -> ${cursorFingerprint(cursor)}`,
        );
      }
      if (cursor !== null && cursor === previousCursor && page.pagination.hasMore) {
        log("warning: cursor did not advance between pages; aborting to avoid an infinite loop");
        break;
      }

      for (const t of stats.truncated) {
        flushEmptyStreak();
        log(`truncated ${tableLabel(t.component, t.table)}`);
      }

      const changed = stats.upserted > 0 || stats.deleted > 0;
      if (changed) {
        flushEmptyStreak();
        lastDetail = describeChanges(stats);
        log(
          `page ${pages} | +${stats.upserted} -${stats.deleted} | ${lastDetail} | ` +
            `fetch ${fetchMs}ms apply ${applyMs}ms | ${statusLabel(page.status.type)}`,
        );
      } else {
        // The server paginates over its internal scan, so pages can be empty
        // while it walks data outside the selection. Aggregate those instead
        // of logging one line each.
        emptyStreak++;
        if (emptyStreak % EMPTY_PAGE_LOG_EVERY === 0) {
          log(`still scanning: ${emptyStreak} consecutive empty pages (page ${pages})`);
        }
      }

      const caughtUp = isCaughtUp(page);
      await refreshTotals();
      if (bar) {
        const done = upserted + deleted;
        let total = totalDocs;
        if (caughtUp || total < done) {
          total = done;
        }
        bar.setTotal(total);
        bar.update(done, { page: pages, detail: lastDetail.slice(0, 60) });
      }

      if (options.maxPages !== undefined && pages >= options.maxPages) {
        flushEmptyStreak();
        log(`reached --max-pages ${options.maxPages}; progress saved, rerun sync to continue`);
        break;
      }

      // hasMore is not a stop signal on its own: the live API keeps it true
      // even once caught up. Stop (or sleep, in watch mode) on the status.
      if (!caughtUp) {
        continue;
      }

      if (!page.pagination.hasMore && page.status.type !== "upToDate" && page.status.type !== "synced") {
        flushEmptyStreak();
        log("server stopped paginating before reaching a consistent snapshot");
      }

      if (!options.watch) {
        break;
      }
      flushEmptyStreak();
      log(`caught up; next poll in ${options.intervalSeconds}s`);
      await interruptibleSleep(options.intervalSeconds * 1000, cancel.signal);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    multibar?.stop();
  }

  flushEmptyStreak();
  const state = store.getState();
  console.log(
    `${interrupted ? "interrupted" : "done"}: ${pages} page(s), ` +
      `${upserted} upserted, ${deleted} deleted` +
      (state.syncedTs !== null ? `, consistent at ts ${state.syncedTs}` : ""),
  );
  for (const stat of store.tableStats()) {
    console.log(`  ${tableLabel(stat.component, stat.table)}: ${stat.documents} document(s)`);
  }
  if (interrupted) {
    console.log("progress is saved; run sync again to resume from the last applied page");
    process.exitCode = 130;
  }
}
