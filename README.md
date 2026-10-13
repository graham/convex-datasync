# datasync

Incremental export of a Convex deployment's data using the [data sync API](https://docs.convex.dev/deployment-api/data-sync) (`POST /api/v1/data/sync`, beta).

Runs on plain node (>= 24; uses the built-in `node:sqlite`).

Documents are mirrored locally, either into a SQLite database (the default) or into an append-only log of parquet deltas (`--store log`). Either way each page from the API is applied atomically together with its cursor, so the local copy is always resumable and never half-applied. Running `sync` again continues from the saved cursor and only pulls what changed.

> The data sync API requires a **Convex Pro plan** on Convex Cloud, and a deploy key with the `deployment:data:view` permission. On a free plan every command that talks to `/data/sync` fails with an authorization error.

## Setup

```sh
npm install          # install dependencies
npm run build        # compiles src/ to dist/ (the bin entry)
npm link             # makes the `datasync` command available globally
```

Credentials are resolved in order:

1. Explicit: `CONVEX_URL` + `CONVEX_DEPLOY_KEY` (real env, `.env.local`, `.env`, or `--url`/`--deploy-key`; that order). The deploy key needs the `deployment:data:view` permission.
2. Project directory: run `datasync` from any Convex project directory. It reads `CONVEX_DEPLOYMENT` from the project's `.env.local` and mints deployment credentials through your `npx convex login` session (`~/.convex/config.json`) — the same mechanism the Convex CLI itself uses. No deploy key needed.

The sync database is named `<deployment-name>.sqlite3` (e.g. `happy-otter-123.sqlite3`) in the current directory, so each project/deployment keeps its own local copy. Override with `--db`.

## Installing in another project

```sh
npm install git+https://github.com/graham/convex-datasync.git
# or from a local checkout:
npm install path/to/datasync
```

This gives you the `datasync` CLI (run via `npx datasync ...`) and a library API:

```ts
import { DataSyncClient, Store, DeltaLogStore, runSync, resolveConnection } from "datasync";

const connection = await resolveConnection({});          // same credential rules as the CLI
const client = new DataSyncClient(connection.url, connection.deployKey);
const store = new Store(`${connection.deploymentName}.sqlite3`);
await runSync(client, store, { watch: false, intervalSeconds: 60 });
for await (const doc of store.readTable("", "users")) {
  console.log(doc._id, doc);
}
store.close();
```

`Store` (sqlite) and `DeltaLogStore` (parquet deltas) both implement the `DataStore` interface that `runSync` and `runExport` take, so they are interchangeable. Reads are async on both: `tableStats()` returns a promise and `readTable()` is an async iterable, since the parquet backend has to decode files to answer them.

The published entry points are compiled JS in `dist/` (built by the `prepare` script on install), so consumers just need node >= 24. To publish to the npm registry, remove `"private": true` and run `npm publish`.

## Usage

```sh
# First run: full copy. Later runs: incremental from the saved cursor.
datasync sync

# Target the current project's prod deployment, or any deployment by name.
datasync sync --prod
datasync sync --deployment brave-cat-123

# Keep polling for new writes (default every 60s once caught up).
datasync sync --watch --interval 30

# See what a sync would cover, and how far behind the local copy is,
# without downloading anything.
datasync dry-run
datasync dry-run --exclude-tables="^auth" --exclude-columns games:description

# Only sync specific root-component tables, exactly or by regex.
datasync sync --tables users,posts
datasync sync --exclude-tables="^auth"       # --ignore-tables is an alias
datasync sync --include-tables="^youtube"

# Narrow further: leave columns on the server, or skip whole components.
datasync sync --exclude-columns youtubeVideos:description
datasync sync --tables games --include-columns title,score
datasync sync --exclude-components videosPerGamePerDay

# Keep rows for deleted documents (deleted flag set, last value preserved)
# instead of removing them.
datasync sync --keep-deleted

# Bounded run (progress saved; rerun to continue) and per-page debug output.
datasync sync --max-pages 100
datasync sync --debug

# Discard local data and cursor, start over.
datasync sync --fresh

# Local state and per-table document counts, plus the deployment's own view.
datasync status
datasync status --remote

# Live data syncs on the deployment (server-side view, via
# /data/list_active_syncs); the one this database follows is marked.
datasync list
datasync list --limit 5

# The command reference.
datasync help

# Dump synced tables to export/<component>/<table>.jsonl.
datasync export
datasync export --out dump --format json
datasync export --format csv
datasync export --format parquet

# Keep parquet (or csv/json/jsonl) files up to date as part of every sync,
# alongside the sqlite mirror. Without --format, sync writes sqlite only.
datasync sync --format parquet
datasync sync --format csv --out dump --watch

# Rewrite every file, including tables this run did not change.
datasync sync --format parquet --fresh-export
```

## Commands

Running `datasync` with no command runs `sync`. `datasync help` (or `--help`) prints the same reference.

### sync (default)

Fetches pages from `/data/sync` until the deployment reports the sync is caught up, applying each page atomically with its cursor. Rerunning resumes incrementally.

- Connection: `--url <url>`, `--deploy-key <key>` (default from env), `--prod` (the current project's prod deployment), `--deployment <name>` (any deployment, bare or `prod:`-prefixed). `--prod`/`--deployment` take precedence over env credentials and require an `npx convex login` session.
- Storage: `--store sqlite` (default) with `--db <path>` (default `<deployment-name>.sqlite3`), or `--store log` with `--log-dir <dir>` (default `<deployment-name>.deltalog`); see [Parquet all the way down](#parquet-all-the-way-down---store-log).
- Table selection: `--tables <a,b,c>` (exact list), or `--include-tables <regex>` / `--exclude-tables <regex>` (`--ignore-tables` is an alias for exclude). The exact list cannot be combined with the regex flags. Filters apply to root-component tables. See [Selecting tables, columns and components](#selecting-tables-columns-and-components) for the one undocumented call the regex flags make.
- Column selection: `--exclude-columns <spec>` or `--include-columns <spec>`; see [Selecting columns and components](#selecting-columns-and-components).
- Component selection: `--components <a,b,c>` / `--exclude-components <a,b,c>`, same section.
- Output: `--format jsonl|json|csv|parquet` plus `--out <dir>` (default `export`) to also keep files in that format up to date; see [Syncing straight to files](#syncing-straight-to-files). Omit `--format` and sync writes only the sqlite mirror.
- Behavior: `--keep-deleted` (mark deletions instead of removing rows), `--fresh` (discard local data and cursor first), `--fresh-export` (rewrite every `--format` file, changed or not), `--watch` (keep polling after catching up), `--interval <secs>` (watch poll interval, default 60), `--max-pages <n>` (stop after n pages; progress is saved, rerun to continue), `--debug` (log every page, including empty ones, with cursor fingerprints).

### dry-run

Shows the scope of a sync and how far the local copy is from the deployment, downloading and writing nothing. It takes the connection flags, `--store`/`--db`/`--log-dir`, and the same selection flags as `sync` (`--tables`, the table patterns, `--components`, `--exclude-components`, `--include-columns`, `--exclude-columns`), so you can try a selection before running it:

```
scope:
  root tables:  3 of 28, 12947 document(s)
  skipped:      25 table(s): aggregateRows, authAccounts, ... and 17 more
  components:   all (their tables cannot be counted, only synced)
  columns:      dropping games:blob

table                     server    local    delta
featureRequests                3        0       +3  not synced yet
games                      12942        0   +12942  not synced yet
users                          2        0       +2  not synced yet
```

- The scope block is the part to read before a first backup: how many root tables and documents the flags select, what they skip, and which components and columns are in or out. Components other than the root cannot be counted, only listed.
- The table compares the deployment's document count per table with the local copy: `delta` is what a sync would bring in (or remove). A table the flags skip appears only if the local copy still holds documents from it. Counts cannot detect in-place updates, so a table can match and still have changed documents; sync is the source of truth.
- It refuses what `sync` would refuse, for example a `table:column` entry for a table the pattern drops, before reporting anything.
- It never creates the local copy: before a first sync every table simply reads as not synced yet.
- **It uses two admin queries outside the documented API**, the table list and the per-table document count (`_system/cli/tables` and `_system/frontend/tableSize` on `/api/query`). Nothing documented offers either. They are confined to `dry-run` and the table patterns, so a sync that names its tables with `--tables` never depends on them.

### status

Offline: prints the saved syncId, status, consistency timestamp, and per-table counts (with deleted counts when `--keep-deleted` was used) from the local copy. Accepts `--store`/`--db`/`--log-dir`, `--url`, `--deployment` for locating it. `--prod` alone is rejected here (the prod deployment's name — and so its db file — requires a network call): pass `--deployment <name>` or `--db`.

`--remote` additionally asks the deployment for its own view of this sync, via `GET /data/sync/{syncId}`, and when it last served a page. While the sync is still traversing, that is the phase, tables and documents synced against the totals, and the table it is on. Once it has a consistent snapshot it is the table and document counts and the timestamp the data is consistent at. A sync stays active for three days after its last page, and `--remote` says so explicitly when the deployment has forgotten it, rather than leaving you to discover it as a refused cursor on the next run.

### list (alias: active-syncs)

Lists the deployment's live data syncs via `/data/list_active_syncs` (anything that fetched a page in the past 3 days), most recently updated first, following pagination. The sync your local database follows is marked `<- this database`. Accepts the connection flags. To look at just your own sync, `status --remote` fetches it by id instead of listing every one.

`--limit <n>` (1 to 100) passes the endpoint's `limit` parameter and returns that one page, noting when more exist. The deployment answers 400 outside that range, so the flag is validated before any request is made, even though the docs describe larger values as capped.

### export

Offline: dumps synced tables to `<out>/<componentPath>/<table>.<format>`. Flags: `--out <dir>` (default `export`), `--format jsonl|json|csv|parquet` (default `jsonl`), plus `--store`/`--db`/`--log-dir`/`--url`/`--deployment` as in `status` (same `--prod` restriction). Exports live documents only; tombstoned rows kept by `--keep-deleted` are excluded.

#### Tabular formats (csv, parquet)

`jsonl` and `json` write documents as they came from the deployment. `csv` and `parquet` are tabular, and Convex documents are schemaless, so a table's columns are derived from its contents:

- The column set is the union of every top-level key in the table — `_id` and `_creationTime` first, then the rest alphabetically. A document missing a key gets an empty/null cell.
- Each column gets one type: `boolean`, `number` (parquet `DOUBLE`; Convex numbers are IEEE-754 doubles) or `string`. Nested objects and arrays, and columns whose type varies between documents, are serialized as JSON text (parquet's `JSON` logical type, which readers like DuckDB expose as a JSON column).
- CSV follows RFC 4180 with a header row and LF line endings. As in Postgres `COPY ... CSV`, a null (or a missing key) is a bare empty field while an empty string is written as `""`, so the two stay distinguishable.
- Parquet is written by [hyparquet-writer](https://github.com/hyparam/hyparquet-writer) — pure JS, no native dependencies — with the default SNAPPY compression.

Both formats build a table's rows in memory before writing, so a very large table costs roughly its JSON size in RAM.

## Syncing straight to files

`sync --format <fmt>` keeps files in that format up to date as part of the sync, so you do not have to remember a separate `export` run:

```sh
datasync sync --format parquet              # sqlite mirror + export/<table>.parquet
datasync sync --format csv --out dump --watch
```

SQLite is still written, and still the source of truth: it holds the cursor that makes the sync incremental, and the tombstones that `--keep-deleted` preserves. The csv/parquet files are derived from it.

- Files are rewritten whole from sqlite, never patched, so each one always holds a consistent snapshot of its table — deletions and truncations disappear from it as they should.
- Only tables that changed during the run are rewritten, plus any whose file is missing (first run, or you deleted the output). A sync that pulls nothing new touches no files. With `--watch`, files are refreshed after every poll that applied changes.
- A run cut short by ctrl-c or `--max-pages` writes what it applied before exiting. If the process is killed outright (`kill -9`) mid-run, the record of which tables changed dies with it, so a file can be left stale until that table next changes — `--fresh-export` (below) or a plain `datasync export --format <fmt>` rewrites everything and fixes it.

### Forcing a rewrite

`sync --fresh-export` ignores the change tracking and rewrites the file for every synced table, whether or not this run touched it:

```sh
datasync sync --format parquet --fresh-export
```

It needs `--format` (there is nothing to refresh otherwise) and applies to `sync` only — `export` already rewrites every table on every run, so `datasync export --format parquet` is the other way to get the same result without syncing.

Under `--watch` it forces the run's first write only; later polls go back to writing just what changed, so watching does not mean rewriting the whole export every minute. Nothing is deleted: files for tables that are no longer synced, or left over from a different `--format`, stay where they are.

Note this is not `--fresh`, which throws away the local data and cursor and re-downloads the deployment from scratch. `--fresh-export` re-derives files from the sqlite mirror you already have and never touches the network.

## Parquet all the way down (`--store log`)

Everything above keeps sqlite as the mirror and writes files from it. `--store log` drops sqlite entirely: the sync state goes in a small `cursor.json` and the data becomes an append-only log of parquet deltas.

```sh
datasync sync --store log                        # -> <deployment-name>.deltalog/
datasync sync --store log --log-dir data/ --watch
datasync status --store log --log-dir data/
datasync export --store log --log-dir data/ --format csv
```

```
data/
  cursor.json                        cursor, syncId, status, high-water _seq
  fold.sql                           the query below, ready to run
  _root/games/000000000001.parquet   root component tables
  _root/games/000000000004.parquet
  waitlist/users/000000000009.parquet   component tables, under their path
```

Every page of changes becomes **new** files. Nothing already written is ever reopened, which is what makes this cheap: applying one changed document to a 110k-row table costs **0.7ms**, against 3ms for sqlite and 7.6s for the read-modify-write you would need to keep a single parquet file per table current.

It also avoids a correctness trap. Parquet has null but no "absent", so a document read back out of a merged parquet file acquires a null for every column any of its table-mates ever had, and the drift compounds every cycle. A delta only ever carries the columns its own documents had, and is never rewritten, so the log stays faithful to what the deployment actually sent.

Each row carries two reserved fields — `_seq`, increasing across the whole log, and `_op` (`u` upsert, `d` delete, `t` truncate). Convex reserves the underscore prefix for system fields, so these cannot collide with your data; a document that somehow carries one is rejected rather than silently mangled.

### Reading the log

Replay the deltas in `_seq` order. `fold.sql` in the log directory holds this, with `<table>` to substitute:

```sql
select * exclude (_op, _seq, rn) from (
  select *, row_number() over (partition by _id order by _seq desc) rn
  from read_parquet('<table>/*.parquet', union_by_name = true)
  where _seq > coalesce(
    (select max(_seq) from read_parquet('<table>/*.parquet', union_by_name = true) where _op = 't'),
    -1)
) where rn = 1 and _op <> 'd';
```

`union_by_name = true` is load-bearing: deltas deliberately have different column sets. The `_op = 't'` clause discards everything up to the last truncate — truncates are written with a lower `_seq` than the values in their own page, so a table truncated and refilled in one page folds correctly.

`status` and `export` do this fold internally, so they work the same as with sqlite. Folding 3,001 delta files into 110k live documents takes ~1.2s in-process, or ~244ms in DuckDB.

### Trade-offs

- **The log only grows.** There is no compaction yet, so a long-running `--watch` accumulates files. 3,001 files still fold in well under a second, so there is room, but this is the thing to watch. `datasync export --store log --format parquet` folds the log into ordinary flat files whenever you want a compacted copy.
- **Reads cost a fold.** `status` on the log is ~1.2s where sqlite is instant, because counting live documents means replaying the log.
- **Consumers must fold.** A delta file on its own is not the table — `games/000000000004.parquet` holds a page of changes, not the current data. Point tools at `fold.sql`, not at individual files.
- **sqlite remains the default** and is still the better choice if you want a queryable local mirror or the fastest possible reads.

`--format` is rejected on the commands it would not affect (`dry-run`, `status`, `list`) rather than being silently ignored.

## Selecting tables, columns and components

The data sync API's `selection` argument reaches three levels: components, the tables in them, and the columns of those tables. Table and column flags address root-component tables; component flags address whole components.

```sh
# Leave a heavy field on the server. The rest of the document still syncs.
datasync sync --exclude-columns youtubeVideos:description

# Table patterns, resolved against the deployment's table list.
datasync sync --exclude-tables="^auth"
datasync sync --include-tables="^youtube" --exclude-columns description

# Keep only these columns of one table. _id always comes through; everything
# else, _creationTime included, is left behind.
datasync sync --include-columns games:title,games:score

# A bare column name applies to every table named by --tables.
datasync sync --tables games,users --exclude-columns description

# Components, named by path. _root names the root component.
datasync sync --exclude-components videosPerGamePerDay
datasync sync --components _root,waitlist
```

- A column spec is a comma-separated list of `table:column` entries, or of bare `column` names when `--tables` or a table regex says which tables they apply to. A bare name with neither is rejected: the schema can only attach a column selection to a table that is named, and nothing else names the tables. `--include-columns` and `--exclude-columns` cannot be combined.
- `_id` cannot be excluded — the deployment refuses it, and the store keys documents by it — so `--exclude-columns games:_id` is rejected rather than quietly ignored.
- **The regex flags make one call outside the documented API.** The data sync endpoints take tables by name and cannot list them, so `--include-tables` and `--exclude-tables` ask the deployment for its table names through the admin query the Convex CLI uses (`_system/cli/tables` on `/api/query`). `dry-run` adds a second such query for document counts. Everything else in this tool uses the three documented endpoints. If those queries ever change, only the table patterns and `dry-run` are affected; `--tables` and `table:column` need no listing and keep working.
- A table that no column entry names keeps all of its columns, so `--include-columns games:title` narrows `games` and leaves every other table whole.
- Column entries for a table that the table selection does not include are an error rather than a silent no-op: `--tables games --exclude-columns users:email` is rejected.
- Dropping a column stops it being transferred at all, so it also shrinks what the deployment reads.
- The selection may change between runs of the same sync. Tables you newly select are synced from scratch, and the deployment emits a truncate for each so the local copy starts them clean; it may also move the sync back to `snapshotting`. Tables you deselect simply stop being synced: what was already stored for them stays in the local copy, as do columns you stop selecting. Use `--fresh` for a clean slate.

The request is sent in the API's documented vocabulary, `included` / `excluded`. A component or table that is included is written as an object (`{ "_other": "included" }`); only `excluded` may stand alone as a string, and the deployment rejects a bare `"included"` with a 400.

## Output

On a TTY, sync shows a progress bar (documents synced vs the deployment total, refreshed from `/data/sync/:sync_id`) with per-page log lines above it: tables changed, upsert/delete counts, fetch/apply timing. Pages with no matching changes are aggregated into a single "empty page(s) scanned" line instead of being logged individually — the server paginates over its internal scan, so empty pages are normal while it walks data outside your selection.

## Interrupting a sync

Ctrl-c is always safe. Every page is applied to SQLite in one transaction together with its cursor, so the local copy can never be half-applied — even `kill -9` mid-sync just means the next run resumes from the last fully-applied page. On ctrl-c the tool aborts the in-flight request, prints a summary, and exits with code 130; press ctrl-c twice to force quit.

## How incremental sync works

- The API streams pages of document upserts and tombstones, plus table truncations, with an opaque `nextCursor` per page.
- Pages are fetched until the first page whose status is `upToDate`, which is how the docs say a one-time sync ends. The endpoint is an infinite stream — `hasMore` is always `true` and there is always a `nextCursor` — so neither says anything about progress; only the status does. `snapshotting` means the traversal is still under way. `stale` is a consistent snapshot at an older timestamp with newer changes still to come, so the tool keeps going through it. With `--watch` the tool sleeps between `upToDate` pages, as the docs recommend, and keeps polling instead of exiting. If a selection change or a bulk operation sends the sync back to `snapshotting`, pages are fetched without sleeping until it is caught up again.
- The cursor is stored next to the data (in the SQLite database, or `cursor.json` for `--store log`). The next run resumes from it.
- A sync stays active for 3 days after its last page. Past that the deployment refuses its cursor, and the tool exits with instructions to rerun with `--fresh`; so does a cursor it cannot parse. `status --remote` shows whether the deployment still knows the sync before you get that far.
- Timestamps in the API (`ts`, `snapshotTs`, `syncedTs`) are int64 nanoseconds, more than a JS number holds exactly. They are read as `bigint` and stored as exact decimal strings, so what `status` prints matches what the deployment reports to the last digit.

## Development

```sh
npm run test         # node --test
npm run typecheck    # tsc --noEmit
npm run build        # emit dist/
```

The source runs directly under node's native TypeScript support (`node src/cli.ts ...`); `dist/` is only needed for the installed bin and library entry points. `--keep-deleted` details: tombstones from the API carry only `_id`, so the row's `value` column keeps the last-synced document; `readTable(component, table, true)` includes tombstoned rows, and exports and counts cover live documents only.
