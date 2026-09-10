import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { DataSyncResponse } from "../src/api.ts";
import { collect } from "../src/datastore.ts";
import { DeltaLogStore } from "../src/deltalog.ts";
import { writeParquetFile } from "../src/parquet.ts";

const root = mkdtempSync(join(tmpdir(), "datasync-deltalog-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const logDir = (): string => join(root, `log${counter++}`);

function page(overrides: Partial<DataSyncResponse>): DataSyncResponse {
  return {
    pagination: { hasMore: true, nextCursor: "cursor-1" },
    status: { type: "inProgress" },
    syncId: "sync-1",
    truncates: [],
    values: [],
    ...overrides,
  };
}

function upsert(table: string, value: Record<string, unknown>, ts = 10, component = "") {
  return { component, table, deleted: false, ts, value };
}

function remove(table: string, id: string, ts = 20, component = "") {
  return { component, table, deleted: true, ts, value: { _id: id } };
}

const ids = (docs: Record<string, unknown>[]) => docs.map((d) => d._id);

describe("DeltaLogStore", () => {
  test("applying a page writes new delta files and never rewrites old ones", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(page({ values: [upsert("users", { _id: "u1", n: 1 })] }));
    const first = readdirSync(join(dir, "_root", "users"));
    assert.equal(first.length, 1);
    const firstBytes = readFileSync(join(dir, "_root", "users", first[0] as string));

    store.applyPage(page({ values: [upsert("users", { _id: "u2", n: 2 })] }));
    const second = readdirSync(join(dir, "_root", "users")).sort();
    assert.equal(second.length, 2);
    assert.deepEqual(readFileSync(join(dir, "_root", "users", first[0] as string)), firstBytes);
    store.close();
  });

  test("folds deltas back into the current documents", async () => {
    const store = new DeltaLogStore(logDir());
    store.applyPage(
      page({
        values: [upsert("users", { _id: "u1", n: 1 }), upsert("users", { _id: "u2", n: 2 })],
      }),
    );
    store.applyPage(page({ values: [upsert("users", { _id: "u1", n: 99 })] }));
    const docs = await collect(store.readTable("", "users"));
    assert.deepEqual(docs, [{ _id: "u1", n: 99 }, { _id: "u2", n: 2 }]);
    store.close();
  });

  test("a delta only carries the columns its own documents had", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(page({ values: [upsert("users", { _id: "u1", n: 1 })] }));
    store.applyPage(page({ values: [upsert("users", { _id: "u2", n: 2, extra: "new" })] }));
    const [firstFile] = readdirSync(join(dir, "_root", "users")).sort();
    const rows = await parquetReadObjects({
      file: await asyncBufferFromFile(join(dir, "_root", "users", firstFile as string)),
    });
    // The whole point: the older delta is untouched by the later column, so no
    // document ever acquires a null for a field it never had.
    assert.deepEqual(Object.keys(rows[0] as object).sort(), ["_id", "_op", "_seq", "n"]);
    assert.deepEqual(await collect(store.readTable("", "users")), [
      { _id: "u1", n: 1 },
      { _id: "u2", n: 2, extra: "new" },
    ]);
    store.close();
  });

  test("tombstones remove the document from the fold", async () => {
    const store = new DeltaLogStore(logDir());
    store.applyPage(
      page({ values: [upsert("users", { _id: "u1" }), upsert("users", { _id: "u2" })] }),
    );
    const stats = store.applyPage(page({ values: [remove("users", "u1")] }));
    assert.equal(stats.deleted, 1);
    assert.deepEqual(ids(await collect(store.readTable("", "users"))), ["u2"]);
    store.close();
  });

  test("keepDeleted surfaces tombstones with their last-synced value", async () => {
    const store = new DeltaLogStore(logDir(), { keepDeleted: true });
    store.applyPage(page({ values: [upsert("users", { _id: "u1", name: "a" })] }));
    store.applyPage(page({ values: [remove("users", "u1")] }));
    assert.deepEqual(await collect(store.readTable("", "users")), []);
    assert.deepEqual(await collect(store.readTable("", "users", true)), [{ _id: "u1", name: "a" }]);
    const [stat] = await store.tableStats();
    assert.equal(stat?.documents, 0);
    assert.equal(stat?.deletedDocuments, 1);
    store.close();
  });

  test("a re-upsert after a delete brings the document back", async () => {
    const store = new DeltaLogStore(logDir(), { keepDeleted: true });
    store.applyPage(
      page({
        values: [
          upsert("users", { _id: "u1" }),
          remove("users", "u1"),
          upsert("users", { _id: "u1", back: true }),
        ],
      }),
    );
    assert.deepEqual(await collect(store.readTable("", "users")), [{ _id: "u1", back: true }]);
    assert.deepEqual(await collect(store.readTable("", "users", true)), [{ _id: "u1", back: true }]);
    store.close();
  });

  test("truncates drop earlier deltas but keep the values in the same page", async () => {
    const store = new DeltaLogStore(logDir());
    store.applyPage(
      page({ values: [upsert("users", { _id: "u1" }), upsert("users", { _id: "u2" })] }),
    );
    store.applyPage(
      page({
        truncates: [{ component: "", table: "users" }],
        values: [upsert("users", { _id: "u3" }, 30)],
      }),
    );
    assert.deepEqual(ids(await collect(store.readTable("", "users"))), ["u3"]);
    store.close();
  });

  test("a truncate only affects its own table", async () => {
    const store = new DeltaLogStore(logDir());
    store.applyPage(
      page({
        values: [upsert("users", { _id: "u1" }), upsert("users", { _id: "w1" }, 10, "waitlist")],
      }),
    );
    store.applyPage(page({ truncates: [{ component: "waitlist", table: "users" }] }));
    assert.equal((await collect(store.readTable("", "users"))).length, 1);
    assert.equal((await collect(store.readTable("waitlist", "users"))).length, 0);
    store.close();
  });

  test("cursor and sync state survive reopening the log", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(
      page({ status: { type: "synced", syncedTs: 1234 }, values: [upsert("users", { _id: "u1" })] }),
    );
    store.close();

    const reopened = new DeltaLogStore(dir);
    const state = reopened.getState();
    assert.equal(state.cursor, "cursor-1");
    assert.equal(state.syncId, "sync-1");
    assert.equal(state.syncedTs, "1234");
    assert.equal(state.statusType, "synced");
    assert.deepEqual(ids(await collect(reopened.readTable("", "users"))), ["u1"]);
    reopened.close();
  });

  test("sequence numbers keep increasing across reopens, so files never collide", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(page({ values: [upsert("users", { _id: "u1" })] }));
    store.close();
    const reopened = new DeltaLogStore(dir);
    reopened.applyPage(page({ values: [upsert("users", { _id: "u2" })] }));
    const files = readdirSync(join(dir, "_root", "users")).sort();
    assert.equal(files.length, 2);
    assert.deepEqual(ids(await collect(reopened.readTable("", "users"))), ["u1", "u2"]);
    reopened.close();
  });

  test("component tables are stored under their component path", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(page({ values: [upsert("users", { _id: "w1" }, 10, "waitlist/inner")] }));
    assert.ok(existsSync(join(dir, "waitlist", "inner", "users")));
    assert.deepEqual(await store.tableStats(), [
      { component: "waitlist/inner", table: "users", documents: 1, deletedDocuments: 0 },
    ]);
    store.close();
  });

  test("tableStats counts live documents per table", async () => {
    const store = new DeltaLogStore(logDir());
    store.applyPage(
      page({
        values: [
          upsert("users", { _id: "u1" }),
          upsert("users", { _id: "u2" }),
          upsert("posts", { _id: "p1" }),
        ],
      }),
    );
    store.applyPage(page({ values: [remove("users", "u2")] }));
    assert.deepEqual(await store.tableStats(), [
      { component: "", table: "posts", documents: 1, deletedDocuments: 0 },
      { component: "", table: "users", documents: 1, deletedDocuments: 0 },
    ]);
    store.close();
  });

  test("perTable reports only tables with values, matching the sqlite store", async () => {
    const store = new DeltaLogStore(logDir());
    const stats = store.applyPage(
      page({
        truncates: [{ component: "", table: "wiped" }],
        values: [upsert("users", { _id: "u1" })],
      }),
    );
    assert.deepEqual(stats.truncated, [{ component: "", table: "wiped" }]);
    assert.deepEqual(stats.perTable, [
      { component: "", table: "users", upserted: 1, deleted: 0 },
    ]);
    store.close();
  });

  test("stray parquet files in the log directory are not mistaken for tables", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(page({ values: [upsert("users", { _id: "u1" })] }));
    // An export written with --out pointing inside the log directory: real
    // parquet, but not deltas.
    mkdirSync(join(dir, "dump", "nested"), { recursive: true });
    writeParquetFile(join(dir, "dump", "games.parquet"), [{ _id: "g1" }]);
    writeParquetFile(join(dir, "dump", "nested", "posts.parquet"), [{ _id: "p1" }]);
    // And a stray file sitting in a real table's directory.
    writeParquetFile(join(dir, "_root", "users", "notes.parquet"), [{ _id: "x" }]);

    assert.deepEqual(await store.tableStats(), [
      { component: "", table: "users", documents: 1, deletedDocuments: 0 },
    ]);
    assert.deepEqual(ids(await collect(store.readTable("", "users"))), ["u1"]);
    store.close();
  });

  test("reset clears the log and the cursor", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(page({ values: [upsert("users", { _id: "u1" })] }));
    store.reset();
    assert.equal(store.getState().cursor, null);
    assert.deepEqual(await store.tableStats(), []);
    assert.equal(existsSync(join(dir, "_root")), false);
    store.close();
  });

  test("an empty page still advances the cursor without writing deltas", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    store.applyPage(page({ pagination: { hasMore: true, nextCursor: "cursor-9" } }));
    assert.equal(store.getState().cursor, "cursor-9");
    assert.deepEqual(readdirSync(dir).sort(), ["cursor.json", "fold.sql"]);
    store.close();
  });

  test("rejects documents without a string _id", async () => {
    const store = new DeltaLogStore(logDir());
    assert.throws(
      () => store.applyPage(page({ values: [upsert("users", { name: "no id" })] })),
      /no string _id/,
    );
    store.close();
  });

  test("rejects documents carrying the reserved _seq or _op fields", async () => {
    const store = new DeltaLogStore(logDir());
    assert.throws(
      () => store.applyPage(page({ values: [upsert("users", { _id: "u1", _op: "u" })] })),
      /reserved _seq\/_op field/,
    );
    store.close();
  });

  test("writes the fold query into the log directory", async () => {
    const dir = logDir();
    const store = new DeltaLogStore(dir);
    const sql = readFileSync(join(dir, "fold.sql"), "utf8");
    assert.match(sql, /union_by_name = true/);
    assert.match(sql, /row_number\(\) over \(partition by _id order by _seq desc\)/);
    store.close();
  });
});
