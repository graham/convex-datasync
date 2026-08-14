import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, mock, test } from "node:test";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { DataSyncResponse } from "../src/api.ts";
import { EXPORT_FORMATS, isExportFormat, runExport, type ExportFormat } from "../src/export.ts";
import { Store } from "../src/store.ts";

const root = mkdtempSync(join(tmpdir(), "datasync-export-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const outDir = (): string => join(root, `out${counter++}`);

function page(values: DataSyncResponse["values"]): DataSyncResponse {
  return {
    pagination: { hasMore: false, nextCursor: "c" },
    status: { type: "synced", syncedTs: 1 },
    syncId: "s",
    truncates: [],
    values,
  };
}

function storeWith(
  docs: { component?: string; table: string; value: Record<string, unknown> }[],
  options?: { keepDeleted?: boolean },
): Store {
  const store = new Store(":memory:", options);
  store.applyPage(
    page(
      docs.map((d) => ({
        component: d.component ?? "",
        table: d.table,
        deleted: false,
        ts: 1,
        value: d.value,
      })),
    ),
  );
  return store;
}

async function exportTo(store: Store, format: ExportFormat): Promise<string> {
  const dir = outDir();
  await runExport(store, { outDir: dir, format });
  return dir;
}

describe("runExport", () => {
  beforeEach(() => {
    mock.method(console, "log", () => {});
  });

  test("isExportFormat accepts every advertised format and nothing else", () => {
    for (const format of EXPORT_FORMATS) {
      assert.equal(isExportFormat(format), true);
    }
    assert.equal(isExportFormat("xlsx"), false);
    assert.equal(isExportFormat(""), false);
  });

  test("writes one file per table, named after the format", async () => {
    const store = storeWith([
      { table: "users", value: { _id: "u1", _creationTime: 1, name: "ada" } },
      { table: "posts", value: { _id: "p1", _creationTime: 2, title: "hello" } },
    ]);
    for (const format of EXPORT_FORMATS) {
      const dir = await exportTo(store, format);
      assert.ok(existsSync(join(dir, `users.${format}`)), `users.${format}`);
      assert.ok(existsSync(join(dir, `posts.${format}`)), `posts.${format}`);
    }
    store.close();
  });

  test("csv output has a header row and one row per document", async () => {
    const store = storeWith([
      { table: "users", value: { _id: "u1", _creationTime: 1, name: "ada", tags: ["x"] } },
      { table: "users", value: { _id: "u2", _creationTime: 2, name: null } },
    ]);
    const dir = await exportTo(store, "csv");
    assert.equal(
      readFileSync(join(dir, "users.csv"), "utf8"),
      '_id,_creationTime,name,tags\nu1,1,ada,"[""x""]"\nu2,2,,\n',
    );
    store.close();
  });

  test("parquet output reads back as the synced documents", async () => {
    const store = storeWith([
      { table: "users", value: { _id: "u1", _creationTime: 1, name: "ada", meta: { n: 1 } } },
      { table: "users", value: { _id: "u2", _creationTime: 2, name: "bob", meta: { n: 2 } } },
    ]);
    const dir = await exportTo(store, "parquet");
    const file = await asyncBufferFromFile(join(dir, "users.parquet"));
    assert.deepEqual(await parquetReadObjects({ file }), [
      { _id: "u1", _creationTime: 1, name: "ada", meta: { n: 1 } },
      { _id: "u2", _creationTime: 2, name: "bob", meta: { n: 2 } },
    ]);
    store.close();
  });

  test("component tables go into a subdirectory in every format", async () => {
    const store = storeWith([
      { component: "waitlist/inner", table: "users", value: { _id: "w1", _creationTime: 1 } },
    ]);
    for (const format of EXPORT_FORMATS) {
      const dir = await exportTo(store, format);
      assert.ok(existsSync(join(dir, "waitlist", "inner", `users.${format}`)), format);
    }
    store.close();
  });

  test("deleted documents kept by --keep-deleted are excluded from csv and parquet", async () => {
    const store = new Store(":memory:", { keepDeleted: true });
    store.applyPage(
      page([
        { component: "", table: "users", deleted: false, ts: 1, value: { _id: "u1", n: 1 } },
        { component: "", table: "users", deleted: false, ts: 1, value: { _id: "u2", n: 2 } },
        { component: "", table: "users", deleted: true, ts: 2, value: { _id: "u2" } },
      ]),
    );
    const csvDir = await exportTo(store, "csv");
    assert.equal(readFileSync(join(csvDir, "users.csv"), "utf8"), "_id,n\nu1,1\n");

    const parquetDir = await exportTo(store, "parquet");
    const file = await asyncBufferFromFile(join(parquetDir, "users.parquet"));
    assert.deepEqual(await parquetReadObjects({ file }), [{ _id: "u1", n: 1 }]);
    store.close();
  });

  test("a table holding only tombstones exports an empty file, not a crash", async () => {
    const store = new Store(":memory:", { keepDeleted: true });
    store.applyPage(
      page([{ component: "", table: "users", deleted: true, ts: 1, value: { _id: "ghost" } }]),
    );
    const csvDir = await exportTo(store, "csv");
    assert.equal(readFileSync(join(csvDir, "users.csv"), "utf8"), "");

    const parquetDir = await exportTo(store, "parquet");
    const file = await asyncBufferFromFile(join(parquetDir, "users.parquet"));
    assert.deepEqual(await parquetReadObjects({ file }), []);
    store.close();
  });

  test("an empty store writes nothing", async () => {
    const store = new Store(":memory:");
    const dir = await exportTo(store, "csv");
    assert.equal(existsSync(dir), false);
    store.close();
  });

  test("jsonl and json output are unchanged", async () => {
    const store = storeWith([
      { table: "users", value: { _id: "u1", _creationTime: 1, name: "ada" } },
    ]);
    const jsonlDir = await exportTo(store, "jsonl");
    assert.equal(
      readFileSync(join(jsonlDir, "users.jsonl"), "utf8"),
      '{"_id":"u1","_creationTime":1,"name":"ada"}\n',
    );
    const jsonDir = await exportTo(store, "json");
    assert.deepEqual(JSON.parse(readFileSync(join(jsonDir, "users.json"), "utf8")), [
      { _id: "u1", _creationTime: 1, name: "ada" },
    ]);
    store.close();
  });
});
