// An append-only log of parquet deltas, as an alternative to the SQLite
// mirror. Every page of changes becomes new parquet files; nothing already
// written is ever read back to be rewritten.
//
// That is what makes it cheap. Parquet has no in-place update, so mirroring
// into one file per table would mean reading and rewriting the whole file per
// page - and reading parquet back is lossy for that purpose, since parquet has
// null but no "absent", so every document would pick up a null for every
// column any of its table-mates ever had. Appending sidesteps both: a delta
// carries only the columns its own documents had, and stays as written.
//
// Layout:
//   <dir>/cursor.json                          sync state, incl. the high-water _seq
//   <dir>/fold.sql                             the query a consumer runs
//   <dir>/_root/<table>/<seq>.parquet          root component tables
//   <dir>/<component>/<table>/<seq>.parquet    component tables
//
// Every row carries _seq (increasing across the whole log) and _op ("u"
// upsert, "d" delete, "t" truncate). Replaying rows in _seq order rebuilds the
// table.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parquetReadObjects } from "hyparquet";
import { consistentTs, type DataSyncResponse } from "./api.ts";
import type {
  DataStore,
  PageStats,
  StoreOptions,
  SyncState,
  TableChange,
  TableStat,
} from "./datastore.ts";
import { writeParquetFile } from "./parquet.ts";

// Convex reserves the underscore prefix for system fields, so these cannot
// collide with a user's document fields. applyPage checks anyway.
const SEQ = "_seq";
const OP = "_op";
const ROOT_DIR = "_root";
const CURSOR_FILE = "cursor.json";
const FOLD_FILE = "fold.sql";

type Op = "u" | "d" | "t";

interface CursorFile extends SyncState {
  seq: number;
}

const EMPTY_STATE: CursorFile = {
  cursor: null,
  syncId: null,
  syncedTs: null,
  statusType: null,
  updatedAt: null,
  seq: 0,
};

function componentDir(component: string): string {
  if (component === "") {
    return ROOT_DIR;
  }
  if (component.split("/")[0] === ROOT_DIR) {
    throw new Error(
      `component "${component}" collides with the root component's ${ROOT_DIR} directory`,
    );
  }
  return join(...component.split("/"));
}

// Zero-padded so lexicographic file order is sequence order.
const SEQ_DIGITS = 12;
const DELTA_FILE = new RegExp(`^\\d{${SEQ_DIGITS}}\\.parquet$`);

function seqName(seq: number): string {
  return `${String(seq).padStart(SEQ_DIGITS, "0")}.parquet`;
}

// Only files this store wrote count as deltas. Ordinary parquet files that
// happen to sit in the log directory - an export written to --out under it,
// say - must not be mistaken for a table's history.
function isDeltaFile(name: string): boolean {
  return DELTA_FILE.test(name);
}

interface Folded {
  live: Map<string, Record<string, unknown>>;
  deleted: Map<string, Record<string, unknown>>;
}

export class DeltaLogStore implements DataStore {
  private readonly dir: string;
  private readonly keepDeleted: boolean;
  private state: CursorFile;

  constructor(dir: string, options: StoreOptions = {}) {
    this.dir = dir;
    this.keepDeleted = options.keepDeleted ?? false;
    mkdirSync(this.dir, { recursive: true });
    this.state = this.readState();
    writeFileSync(join(this.dir, FOLD_FILE), foldQuery("<table>/*.parquet"));
  }

  private get cursorPath(): string {
    return join(this.dir, CURSOR_FILE);
  }

  private readState(): CursorFile {
    if (!existsSync(this.cursorPath)) {
      return { ...EMPTY_STATE };
    }
    return { ...EMPTY_STATE, ...JSON.parse(readFileSync(this.cursorPath, "utf8")) } as CursorFile;
  }

  // Written last, and atomically: if the process dies after the delta files
  // but before this, the cursor still points at the older page, so the next
  // run refetches it and rewrites the same _seq-named files with the same
  // content. Redundant work, never a gap.
  private writeState(): void {
    const temp = `${this.cursorPath}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state, null, 2) + "\n");
    renameSync(temp, this.cursorPath);
  }

  private tableDir(component: string, table: string): string {
    return join(this.dir, componentDir(component), table);
  }

  applyPage(page: DataSyncResponse): PageStats {
    const stats: PageStats = { truncated: [], upserted: 0, deleted: 0, perTable: [] };
    const changes = new Map<string, TableChange>();
    type Bucket = { component: string; table: string; rows: Record<string, unknown>[] };
    const rows = new Map<string, Bucket>();
    let seq = this.state.seq;

    const bucket = (component: string, table: string): Record<string, unknown>[] => {
      const key = `${component}\0${table}`;
      let entry = rows.get(key);
      if (!entry) {
        entry = { component, table, rows: [] };
        rows.set(key, entry);
      }
      return entry.rows;
    };

    // Counted separately from bucket(): a table that only got truncated has no
    // upserts or deletes to report, and the SQLite store leaves it out of
    // perTable too.
    const changeFor = (component: string, table: string): TableChange => {
      const key = `${component}\0${table}`;
      let change = changes.get(key);
      if (!change) {
        change = { component, table, upserted: 0, deleted: 0 };
        changes.set(key, change);
      }
      return change;
    };

    // Truncates first, and with lower sequence numbers than the same page's
    // values, so a fold that discards everything up to the last truncate still
    // keeps the values that arrived with it.
    for (const t of page.truncates) {
      bucket(t.component, t.table).push({ [SEQ]: ++seq, [OP]: "t" satisfies Op, _id: null });
      stats.truncated.push({ component: t.component, table: t.table });
    }

    for (const v of page.values) {
      const id = v.value._id;
      if (typeof id !== "string") {
        throw new Error(`document in ${v.component || "<root>"}/${v.table} has no string _id`);
      }
      if (SEQ in v.value || OP in v.value) {
        throw new Error(
          `document ${id} in ${v.component || "<root>"}/${v.table} has a reserved ${SEQ}/${OP} field`,
        );
      }
      const entry = bucket(v.component, v.table);
      const change = changeFor(v.component, v.table);
      if (v.deleted) {
        entry.push({ [SEQ]: ++seq, [OP]: "d" satisfies Op, _id: id });
        stats.deleted++;
        change.deleted++;
      } else {
        entry.push({ [SEQ]: ++seq, [OP]: "u" satisfies Op, ...v.value });
        stats.upserted++;
        change.upserted++;
      }
    }

    for (const { component, table, rows: entry } of rows.values()) {
      if (entry.length === 0) {
        continue;
      }
      const dir = this.tableDir(component, table);
      mkdirSync(dir, { recursive: true });
      // Named for the file's first sequence number, so files sort in order.
      writeParquetFile(join(dir, seqName(entry[0]?.[SEQ] as number)), entry);
    }

    const ts = consistentTs(page.status);
    this.state = {
      cursor: page.pagination.nextCursor ?? null,
      syncId: page.syncId,
      syncedTs: ts === null ? null : String(ts),
      statusType: page.status.type,
      updatedAt: Date.now(),
      seq,
    };
    this.writeState();
    stats.perTable = [...changes.values()];
    return stats;
  }

  getState(): SyncState {
    const { cursor, syncId, syncedTs, statusType, updatedAt } = this.state;
    return { cursor, syncId, syncedTs, statusType, updatedAt };
  }

  reset(): void {
    for (const entry of readdirSync(this.dir)) {
      rmSync(join(this.dir, entry), { recursive: true, force: true });
    }
    this.state = { ...EMPTY_STATE };
    this.writeState();
    writeFileSync(join(this.dir, FOLD_FILE), foldQuery("<table>/*.parquet"));
  }

  // Every table directory in the log. A directory of delta files is a table;
  // the path above it is the component. Nothing at the top level is a table -
  // root tables live under _root - so a stray directory there is never
  // mistaken for one.
  tables(): { component: string; table: string }[] {
    const found: { component: string; table: string }[] = [];
    const walk = (dir: string, parts: string[]): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const path = join(dir, entry.name);
        if (parts.length > 0 && readdirSync(path).some(isDeltaFile)) {
          found.push({ component: parts[0] === ROOT_DIR ? "" : parts.join("/"), table: entry.name });
        } else {
          walk(path, [...parts, entry.name]);
        }
      }
    };
    walk(this.dir, []);
    return found.sort(
      (a, b) => a.component.localeCompare(b.component) || a.table.localeCompare(b.table),
    );
  }

  // Replays a table's deltas in sequence order.
  private async fold(component: string, table: string): Promise<Folded> {
    const live = new Map<string, Record<string, unknown>>();
    const deleted = new Map<string, Record<string, unknown>>();
    const dir = this.tableDir(component, table);
    if (!existsSync(dir)) {
      return { live, deleted };
    }
    for (const name of readdirSync(dir).filter(isDeltaFile).sort()) {
      for (const row of await readDeltaFile(join(dir, name))) {
        const op = row[OP] as Op;
        if (op === "t") {
          live.clear();
          deleted.clear();
          continue;
        }
        const id = row._id as string;
        if (op === "d") {
          // Tombstones carry only _id, so keep the last value seen for it.
          deleted.set(id, live.get(id) ?? deleted.get(id) ?? { _id: id });
          live.delete(id);
        } else {
          const doc = { ...row };
          delete doc[SEQ];
          delete doc[OP];
          deleted.delete(id);
          live.set(id, doc);
        }
      }
    }
    return { live, deleted };
  }

  async tableStats(): Promise<TableStat[]> {
    const stats: TableStat[] = [];
    for (const { component, table } of this.tables()) {
      const { live, deleted } = await this.fold(component, table);
      stats.push({
        component,
        table,
        documents: live.size,
        deletedDocuments: this.keepDeleted ? deleted.size : 0,
      });
    }
    return stats;
  }

  async *readTable(
    component: string,
    table: string,
    includeDeleted = false,
  ): AsyncGenerator<Record<string, unknown>> {
    const { live, deleted } = await this.fold(component, table);
    const entries = includeDeleted && this.keepDeleted ? [...live, ...deleted] : [...live];
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [, doc] of entries) {
      yield doc;
    }
  }

  close(): void {
    // Nothing held open: every write lands on disk as it happens.
  }
}

async function readDeltaFile(path: string): Promise<Record<string, unknown>[]> {
  const buffer = readFileSync(path);
  // Buffers come from a shared pool, so hand hyparquet only this file's bytes.
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const rows = await parquetReadObjects({ file: bytes as ArrayBuffer });
  return rows as Record<string, unknown>[];
}

// The SQL a consumer runs to reconstruct a table from its deltas. Written into
// the log directory so the fold does not have to be rediscovered.
export function foldQuery(glob: string): string {
  return `-- Latest revision of every live document; superseded deltas drop out.
-- union_by_name matters: deltas only carry the columns their own documents had.
select * exclude (${OP}, ${SEQ}, rn) from (
  select *, row_number() over (partition by _id order by ${SEQ} desc) rn
  from read_parquet('${glob}', union_by_name = true)
  where ${SEQ} > coalesce(
    (select max(${SEQ}) from read_parquet('${glob}', union_by_name = true) where ${OP} = 't'),
    -1)
) where rn = 1 and ${OP} <> 'd';
`;
}
