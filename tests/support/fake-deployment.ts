// A local stand-in for a Convex deployment, implementing the three documented
// data endpoints plus the one admin query the table filters use:
//
//   POST /api/v1/data/sync
//   GET  /api/v1/data/list_active_syncs
//   GET  /api/v1/data/sync/{syncId}
//   POST /api/query            (_system/cli/tables only)
//
// It is deliberately strict where the real deployment is: a selection has to
// match the documented schema, so a bare "included" for a component is a 400,
// exactly as it is live. int64 timestamps are sent as raw digits, past 2^53,
// so a client that parses them as numbers visibly loses precision.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Doc = Record<string, unknown>;

interface LogEntry {
  op: "u" | "d" | "t";
  component: string;
  table: string;
  ts: bigint;
  doc?: Doc;
  id?: string;
}

type Item =
  | { kind: "truncate"; component: string; table: string }
  | { kind: "value"; component: string; table: string; deleted: boolean; ts: bigint; doc: Doc };

interface SyncRecord {
  id: string;
  selected: Set<string>;
  queue: Item[];
  logPos: number;
  lastUpdated: number;
  status: "snapshotting" | "stale" | "upToDate";
  numDocumentsSynced: number;
  totalDocuments: number;
  current: { component: string; table: string } | null;
  expired: boolean;
  // A table is snapshotted at one ts and then followed from there, so log
  // entries at or before that ts are already in the snapshot.
  snapshotAt: Map<string, bigint>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

const INCLUSION = new Set(["included", "excluded"]);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The documented schema, as the deployment enforces it.
export function validateSelection(selection: unknown): string | null {
  if (!isObject(selection)) return "selection must be an object";
  if (!INCLUSION.has(selection._other as string)) return "selection._other must be included/excluded";
  for (const [component, cs] of Object.entries(selection)) {
    if (component === "_other" || cs === "excluded") continue;
    if (!isObject(cs)) return `data did not match any variant of untagged enum ComponentSelection (${component})`;
    if (!INCLUSION.has(cs._other as string)) return `missing _other for component ${component}`;
    for (const [table, ts] of Object.entries(cs)) {
      if (table === "_other" || ts === "excluded") continue;
      if (!isObject(ts)) return `data did not match any variant of untagged enum TableSelection (${table})`;
      if (!INCLUSION.has(ts._other as string)) return `missing _other for table ${table}`;
      for (const [column, cl] of Object.entries(ts)) {
        if (!INCLUSION.has(cl as string)) return `bad column selection ${column}`;
        if (column === "_id" && cl === "excluded") return "_id cannot be excluded";
      }
    }
  }
  return null;
}

type Projection = ((doc: Doc) => Doc) | null;

function projectionFor(selection: Record<string, unknown> | undefined, component: string, table: string): Projection {
  if (selection === undefined) return (d) => d;
  let cs: unknown = selection[component];
  if (cs === undefined) cs = selection._other === "included" ? { _other: "included" } : "excluded";
  if (cs === "excluded") return null;
  const csObj = cs as Record<string, unknown>;
  let ts: unknown = csObj[table];
  if (ts === undefined) ts = csObj._other === "included" ? { _other: "included" } : "excluded";
  if (ts === "excluded") return null;
  const tsObj = ts as Record<string, string>;
  return (doc) => {
    const out: Doc = {};
    for (const [key, value] of Object.entries(doc)) {
      if (key === "_id" || (tsObj[key] ?? tsObj._other) === "included") out[key] = value;
    }
    return out;
  };
}

const key = (component: string, table: string) => `${component}\0${table}`;

export class FakeDeployment {
  readonly deployKey = "test-deploy-key";
  readonly requests: RecordedRequest[] = [];
  // Documents per page; small so every sync spans several pages.
  pageSize = 2;
  // The real deployment returns a different cursor on every call, even an idle
  // poll. Set this to make caught-up polls repeat their cursor instead, to
  // check that the client does not mistake that for being stuck.
  repeatIdleCursor = false;
  private cursorCounter = 0;
  private readonly tables = new Map<string, Map<string, Doc>>();
  private readonly log: LogEntry[] = [];
  private readonly syncs = new Map<string, SyncRecord>();
  private ts = 1789075524036369000n;
  private clock = 1_790_000_000_000;
  private syncCounter = 0;
  private server: Server | null = null;
  url = "";

  // ---- state the tests arrange ------------------------------------------

  upsert(table: string, doc: Doc, component = ""): void {
    const id = doc._id as string;
    const full = { _creationTime: 1700000000000.5, ...doc };
    this.tableFor(component, table).set(id, full);
    this.log.push({ op: "u", component, table, ts: ++this.ts, doc: full });
  }

  remove(table: string, id: string, component = ""): void {
    this.tableFor(component, table).delete(id);
    this.log.push({ op: "d", component, table, ts: ++this.ts, id });
  }

  truncate(table: string, component = ""): void {
    this.tableFor(component, table).clear();
    this.log.push({ op: "t", component, table, ts: ++this.ts });
  }

  // Makes the deployment forget a sync, as it does 3 days after its last page.
  expire(syncId: string): void {
    const sync = this.syncs.get(syncId);
    if (sync) sync.expired = true;
  }

  get syncIds(): string[] {
    return [...this.syncs.keys()];
  }

  // The exact int64 the deployment reports as its consistent timestamp.
  get currentTs(): bigint {
    return this.ts;
  }

  // Creates idle, caught-up syncs, to give the listing something to paginate.
  addSyncs(count: number): void {
    for (let i = 0; i < count; i++) {
      const id = `bulk-${i}`;
      this.syncs.set(id, {
        id,
        selected: new Set(),
        queue: [],
        logPos: this.log.length,
        lastUpdated: ++this.clock,
        status: "upToDate",
        numDocumentsSynced: i,
        totalDocuments: i,
        current: null,
        expired: false,
        snapshotAt: new Map(),
      });
    }
  }

  syncRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST" && r.path === "/api/v1/data/sync");
  }

  // The default dataset: enough tables, a component, and system tables to
  // exercise every selection flag.
  seed(): this {
    this.upsert("users", { _id: "u1", name: "Ada", email: "ada@example.com" });
    this.upsert("users", { _id: "u2", name: "Bob", email: "bob@example.com" });
    this.upsert("posts", { _id: "p1", title: "Hello", body: "first", tags: ["a", "b"] });
    this.upsert("posts", { _id: "p2", title: "World", body: "second", tags: [] });
    this.upsert("games", { _id: "g1", title: "Portal", score: 9.5, description: "puzzle" });
    this.upsert("games", { _id: "g2", title: "Braid", score: 8.5, description: "time" });
    this.upsert("youtubeVideos", { _id: "v1", title: "A", description: "long text", views: 10 });
    this.upsert("youtubeVideos", { _id: "v2", title: "B", description: "more text", views: 20 });
    this.upsert("authAccounts", { _id: "a1", provider: "password" });
    this.upsert("featureRequests", { _id: "f1", title: "Dark mode", points: 3 });
    this.upsert("btree", { _id: "b1", key: 1 }, "videosPerGamePerDay");
    this.upsert("users", { _id: "w1", name: "Waitlisted" }, "waitlist");
    return this;
  }

  // ---- lifecycle ---------------------------------------------------------

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.closeAllConnections();
      this.server?.close(() => resolve());
    });
  }

  // ---- http --------------------------------------------------------------

  private tableFor(component: string, table: string): Map<string, Doc> {
    let t = this.tables.get(key(component, table));
    if (!t) {
      t = new Map();
      this.tables.set(key(component, table), t);
    }
    return t;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    // Timestamps are int64s past 2^53: emit them as bare digits.
    const text = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? `__I64__${v}` : v)).replace(
      /"__I64__(\d+)"/g,
      "$1",
    );
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  }

  private fail(res: ServerResponse, status: number, code: string, message: string): void {
    this.send(res, status, { code, message });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, body });

    if (req.headers.authorization !== `Convex ${this.deployKey}`) {
      return this.fail(res, 401, "Unauthorized", "bad deploy key");
    }
    if (req.method === "POST" && url.pathname === "/api/v1/data/sync") {
      return this.handleSync(res, body ?? {});
    }
    if (req.method === "GET" && url.pathname === "/api/v1/data/list_active_syncs") {
      return this.handleList(res, url.searchParams);
    }
    const one = /^\/api\/v1\/data\/sync\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) {
      return this.handleGet(res, decodeURIComponent(one[1]!));
    }
    if (req.method === "POST" && url.pathname === "/api/query") {
      return this.handleQuery(res, body);
    }
    return this.fail(res, 404, "NotFound", `no route ${req.method} ${url.pathname}`);
  }

  private handleQuery(
    res: ServerResponse,
    body: { path?: string; args?: { tableName?: string } } | undefined,
  ): void {
    if (body?.path === "_system/frontend/tableSize") {
      const table = this.tables.get(key("", body.args?.tableName ?? ""));
      return this.send(res, 200, { status: "success", value: table?.size ?? 0 });
    }
    if (body?.path !== "_system/cli/tables") {
      return this.send(res, 200, { status: "error", errorMessage: `unknown function ${body?.path}` });
    }
    const names = new Set(["_storage", "_scheduled_functions"]);
    for (const k of this.tables.keys()) {
      const [component, table] = k.split("\0");
      if (component === "") names.add(table!);
    }
    this.send(res, 200, {
      status: "success",
      value: { page: [...names].map((name) => ({ name })), continueCursor: "", isDone: true },
    });
  }

  private status(sync: SyncRecord): Record<string, unknown> {
    const done = {
      totalTables: sync.selected.size,
      numDocumentsSynced: sync.numDocumentsSynced,
      syncedTs: this.ts,
    };
    if (sync.status === "snapshotting") {
      return {
        type: "snapshotting",
        numTablesSynced: 0,
        totalTables: sync.selected.size,
        currentComponent: sync.current?.component ?? "",
        currentTable: sync.current?.table ?? "",
        numDocumentsInCurrentTable: 0,
        totalDocumentsInCurrentTable: 0,
        numDocumentsSynced: sync.numDocumentsSynced,
        totalDocuments: sync.totalDocuments,
      };
    }
    return { type: sync.status, ...done };
  }

  private active(sync: SyncRecord) {
    return { syncId: sync.id, lastUpdated: sync.lastUpdated, status: this.status(sync) };
  }

  private handleGet(res: ServerResponse, id: string): void {
    const sync = this.syncs.get(id);
    if (!sync || sync.expired) {
      return this.fail(res, 404, "DataSyncNotFound", `No active data sync with id ${id}.`);
    }
    this.send(res, 200, this.active(sync));
  }

  private handleList(res: ServerResponse, query: URLSearchParams): void {
    const limitText = query.get("limit");
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return this.fail(res, 400, "LimitOutOfRange", "The limit for listing active syncs must be between 1 and 100");
    }
    const live = [...this.syncs.values()].filter((s) => !s.expired).sort((a, b) => b.lastUpdated - a.lastUpdated);
    const offset = Number(query.get("cursor") ?? 0);
    const slice = live.slice(offset, offset + limit);
    const more = offset + limit < live.length;
    this.send(res, 200, {
      syncs: slice.map((s) => this.active(s)),
      pagination: { hasMore: more, nextCursor: more ? String(offset + limit) : null },
    });
  }

  private handleSync(res: ServerResponse, body: { cursor?: unknown; selection?: unknown }): void {
    if (body.cursor !== undefined && typeof body.cursor !== "string") {
      return this.fail(res, 400, "BadJsonBody", "cursor must be a string when present");
    }
    if (body.selection !== undefined) {
      const problem = validateSelection(body.selection);
      if (problem) return this.fail(res, 400, "BadJsonBody", `selection: ${problem}`);
    }
    const selection = body.selection as Record<string, unknown> | undefined;

    let sync: SyncRecord;
    const isNew = body.cursor === undefined;
    if (isNew) {
      sync = {
        id: `sync-${++this.syncCounter}`,
        selected: new Set(),
        queue: [],
        logPos: this.log.length,
        lastUpdated: 0,
        status: "snapshotting",
        numDocumentsSynced: 0,
        totalDocuments: 0,
        current: null,
        expired: false,
        snapshotAt: new Map(),
      };
      this.syncs.set(sync.id, sync);
    } else {
      const found = this.syncs.get((body.cursor as string).split("|")[0] ?? "");
      if (!found) return this.fail(res, 400, "InvalidDataSyncCursor", "Could not parse the data sync cursor");
      if (found.expired) return this.fail(res, 400, "DataSyncCursorExpired", "The data sync cursor has expired");
      sync = found;
    }

    const now = [...this.tables.keys()].filter((k) => {
      const [component, table] = k.split("\0");
      return projectionFor(selection, component!, table!) !== null;
    });
    const newly = now.filter((k) => !sync.selected.has(k));
    for (const k of newly) {
      const [component, table] = k.split("\0") as [string, string];
      sync.snapshotAt.set(k, this.ts);
      sync.queue.push({ kind: "truncate", component, table });
      for (const doc of [...this.tables.get(k)!.values()].sort((a, b) => (a._id! < b._id! ? -1 : 1))) {
        sync.queue.push({ kind: "value", component, table, deleted: false, ts: this.ts, doc });
      }
    }
    sync.selected = new Set(now);
    sync.totalDocuments = now.reduce((n, k) => n + this.tables.get(k)!.size, 0);

    const truncates: { component: string; table: string }[] = [];
    const values: unknown[] = [];
    let budget = this.pageSize;
    const emit = (component: string, table: string, deleted: boolean, ts: bigint, doc: Doc) => {
      const project = projectionFor(selection, component, table)!;
      values.push({ component, table, deleted, ts, value: deleted ? { _id: doc._id } : project(doc) });
      sync.current = { component, table };
      sync.numDocumentsSynced++;
      budget--;
    };

    while (sync.queue.length > 0) {
      const item = sync.queue[0]!;
      if (item.kind === "truncate") {
        truncates.push({ component: item.component, table: item.table });
        sync.queue.shift();
      } else if (budget > 0) {
        emit(item.component, item.table, item.deleted, item.ts, item.doc);
        sync.queue.shift();
      } else {
        break;
      }
    }
    if (sync.queue.length === 0) {
      while (sync.logPos < this.log.length) {
        const entry = this.log[sync.logPos]!;
        const snapshotAt = sync.snapshotAt.get(key(entry.component, entry.table));
        if (
          projectionFor(selection, entry.component, entry.table) === null ||
          (snapshotAt !== undefined && entry.ts <= snapshotAt)
        ) {
          sync.logPos++;
          continue;
        }
        if (entry.op === "t") {
          truncates.push({ component: entry.component, table: entry.table });
        } else if (budget > 0) {
          emit(entry.component, entry.table, entry.op === "d", entry.ts, entry.doc ?? { _id: entry.id });
        } else {
          break;
        }
        sync.logPos++;
      }
    }

    let status: SyncRecord["status"];
    if (sync.queue.length > 0) status = "snapshotting";
    else if (sync.logPos < this.log.length) status = "stale";
    else status = !isNew && newly.length > 0 ? "stale" : "upToDate";
    sync.status = status;
    sync.lastUpdated = ++this.clock;

    this.send(res, 200, {
      status: status === "snapshotting" ? { type: status } : { type: status, snapshotTs: this.ts },
      truncates,
      values,
      syncId: sync.id,
      pagination: {
        hasMore: true,
        nextCursor:
          `${sync.id}|${sync.logPos}|${sync.queue.length}|` +
          (this.repeatIdleCursor && status === "upToDate" ? 0 : ++this.cursorCounter),
      },
    });
  }
}
