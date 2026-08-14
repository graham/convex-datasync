# datasync

Incremental export of a Convex deployment's data using the [data sync API](https://docs.convex.dev/deployment-api/data-sync) (`POST /api/v1/data/sync`, beta).

Runs on plain node (>= 24; uses the built-in `node:sqlite`).

Documents are mirrored into a local SQLite database. Each page from the API is applied in a single transaction together with its cursor, so the local copy is always resumable and never half-applied. Running `sync` again continues from the saved cursor and only pulls what changed.

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
import { DataSyncClient, Store, runSync, resolveConnection } from "datasync";

const connection = await resolveConnection({});          // same credential rules as the CLI
const client = new DataSyncClient(connection.url, connection.deployKey);
const store = new Store(`${connection.deploymentName}.sqlite3`);
await runSync(client, store, { watch: false, intervalSeconds: 60 });
for (const doc of store.readTable("", "users")) {
  console.log(doc._id, doc);
}
store.close();
```

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

# See which tables have new data without downloading anything.
datasync dry-run

# Only sync specific root-component tables, exactly or by regex.
datasync sync --tables users,posts
datasync sync --exclude-tables="^auth"       # --ignore-tables is an alias
datasync sync --include-tables="^youtube"

# Keep rows for deleted documents (deleted flag set, last value preserved)
# instead of removing them.
datasync sync --keep-deleted

# Bounded run (progress saved; rerun to continue) and per-page debug output.
datasync sync --max-pages 100
datasync sync --debug

# Discard local data and cursor, start over.
datasync sync --fresh

# Local state and per-table document counts.
datasync status

# Live data syncs on the deployment (server-side view, via
# /data/list_active_syncs); the one this database follows is marked.
datasync list

# Dump synced tables to export/<component>/<table>.jsonl.
datasync export
datasync export --out dump --format json
datasync export --format csv
datasync export --format parquet
```

## Commands

Running `datasync` with no command runs `sync`. `datasync help` (or `--help`) prints the same reference.

### sync (default)

Fetches pages from `/data/sync` until the deployment reports the sync is caught up, applying each page atomically with its cursor. Rerunning resumes incrementally.

- Connection: `--url <url>`, `--deploy-key <key>` (default from env), `--prod` (the current project's prod deployment), `--deployment <name>` (any deployment, bare or `prod:`-prefixed). `--prod`/`--deployment` take precedence over env credentials and require an `npx convex login` session.
- Storage: `--db <path>` (default `<deployment-name>.sqlite3`).
- Table selection: `--tables <a,b,c>` (exact list), or `--include-tables <regex>` / `--exclude-tables <regex>` (`--ignore-tables` is an alias for exclude). The exact list cannot be combined with the regex flags. Filters apply to root-component tables.
- Behavior: `--keep-deleted` (mark deletions instead of removing rows), `--fresh` (discard local data and cursor first), `--watch` (keep polling after catching up), `--interval <secs>` (watch poll interval, default 60), `--max-pages <n>` (stop after n pages; progress is saved, rerun to continue), `--debug` (log every page, including empty ones, with cursor fingerprints).

### dry-run

Compares server per-table document counts against the local copy and reports which tables differ — downloads no documents. Accepts the connection, `--db`, and table-selection flags. Root-component tables only; component tables are listed but not comparable.

### status

Offline: prints the saved syncId, status, consistency timestamp, and per-table counts (with deleted counts when `--keep-deleted` was used) from the local database. Accepts `--db`, `--url`, `--deployment` for locating the database. `--prod` alone is rejected here (the prod deployment's name — and so its db file — requires a network call): pass `--deployment <name>` or `--db`.

### list (alias: active-syncs)

Lists the deployment's live data syncs via `/data/list_active_syncs` (anything that fetched a page in the past 3 days), most recently updated first, following pagination. The sync your local database follows is marked `<- this database`. Accepts the connection flags.

### export

Offline: dumps synced tables to `<out>/<componentPath>/<table>.<format>`. Flags: `--out <dir>` (default `export`), `--format jsonl|json|csv|parquet` (default `jsonl`), plus `--db`/`--url`/`--deployment` as in `status` (same `--prod` restriction). Exports live documents only; tombstoned rows kept by `--keep-deleted` are excluded.

#### Tabular formats (csv, parquet)

`jsonl` and `json` write documents as they came from the deployment. `csv` and `parquet` are tabular, and Convex documents are schemaless, so a table's columns are derived from its contents:

- The column set is the union of every top-level key in the table — `_id` and `_creationTime` first, then the rest alphabetically. A document missing a key gets an empty/null cell.
- Each column gets one type: `boolean`, `number` (parquet `DOUBLE`; Convex numbers are IEEE-754 doubles) or `string`. Nested objects and arrays, and columns whose type varies between documents, are serialized as JSON text (parquet's `JSON` logical type, which readers like DuckDB expose as a JSON column).
- CSV follows RFC 4180 with a header row and LF line endings. As in Postgres `COPY ... CSV`, a null (or a missing key) is a bare empty field while an empty string is written as `""`, so the two stay distinguishable.
- Parquet is written by [hyparquet-writer](https://github.com/hyparam/hyparquet-writer) — pure JS, no native dependencies — with the default SNAPPY compression.

Both formats build a table's rows in memory before writing, so a very large table costs roughly its JSON size in RAM.

## Output

On a TTY, sync shows a progress bar (documents synced vs the deployment total, refreshed from `/data/list_active_syncs`) with per-page log lines above it: tables changed, upsert/delete counts, fetch/apply timing. Pages with no matching changes are aggregated into a single "empty page(s) scanned" line instead of being logged individually — the server paginates over its internal scan, so empty pages are normal while it walks data outside your selection.

## Interrupting a sync

Ctrl-c is always safe. Every page is applied to SQLite in one transaction together with its cursor, so the local copy can never be half-applied — even `kill -9` mid-sync just means the next run resumes from the last fully-applied page. On ctrl-c the tool aborts the in-flight request, prints a summary, and exits with code 130; press ctrl-c twice to force quit.

## How incremental sync works

- The API streams pages of document upserts and tombstones, plus table truncations, with an opaque `nextCursor` per page.
- Pages are fetched until the page status reports the sync is caught up (`upToDate` on the live API, `synced` in the newer spec). `hasMore` alone is not a stop signal: the live endpoint keeps returning `hasMore: true` forever, since it is an infinite stream. With `--watch` the tool sleeps between caught-up pages and keeps polling instead of exiting.
- The cursor is stored in the SQLite database next to the data. The next run resumes from it.
- A cursor expires if unused for 3 days. When that happens the tool exits with instructions to rerun with `--fresh`.
- Deselecting a table between runs (via `--tables` or the regex filters) stops exporting it, but documents already synced from it stay in the local database; use `--fresh` if you want a clean slate.
- `dry-run` compares per-table document counts (the same numbers the dashboard shows) between the server and the local copy. It downloads no documents. Counts cannot detect in-place updates, and the regex filters only apply to root-component tables; component tables are listed but not compared.

## Development

```sh
npm run test         # node --test
npm run typecheck    # tsc --noEmit
npm run build        # emit dist/
```

The source runs directly under node's native TypeScript support (`node src/cli.ts ...`); `dist/` is only needed for the installed bin and library entry points. `--keep-deleted` details: tombstones from the API carry only `_id`, so the row's `value` column keeps the last-synced document; `readTable(component, table, true)` includes tombstoned rows, and exports/dry-run counts cover live documents only.
