// The bug these cover: --format was accepted on every command but only read by
// export, so `sync --format parquet` synced to sqlite and silently wrote no
// parquet at all.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, mock, test } from "node:test";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { DataSyncClient, DataSyncResponse } from "../src/api.ts";
import { Store } from "../src/store.ts";
import { runSync } from "../src/sync.ts";

const root = mkdtempSync(join(tmpdir(), "datasync-syncexport-"));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const outDir = (): string => join(root, `out${counter++}`);

function caughtUpPage(values: DataSyncResponse["values"]): DataSyncResponse {
  return {
    pagination: { hasMore: true, nextCursor: "c" },
    status: { type: "upToDate", snapshotTs: 1n },
    syncId: "s",
    truncates: [],
    values,
  };
}

function upsert(table: string, value: Record<string, unknown>, component = "") {
  return { component, table, deleted: false, ts: 1n, value };
}

// Serves the given pages in order, then keeps returning an empty caught-up
// page so watch mode has something to poll.
function clientServing(pages: DataSyncResponse[]): DataSyncClient {
  let index = 0;
  return {
    async fetchPage() {
      return pages[index++] ?? caughtUpPage([]);
    },
    async listActiveSyncs() {
      return { syncs: [] };
    },
  } as unknown as DataSyncClient;
}

async function syncWith(
  store: Store,
  pages: DataSyncResponse[],
  exportTo?: { outDir: string; format: "jsonl" | "csv" | "parquet" | "json"; fresh?: boolean },
): Promise<void> {
  await runSync(clientServing(pages), store, {
    watch: false,
    intervalSeconds: 1,
    exportTo,
  });
}

describe("sync --format", () => {
  beforeEach(() => {
    mock.method(console, "log", () => {});
  });

  test("writes export files in the requested format once caught up", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    await syncWith(
      store,
      [caughtUpPage([upsert("users", { _id: "u1", _creationTime: 1, name: "ada" })])],
      { outDir: dir, format: "parquet" },
    );
    const file = await asyncBufferFromFile(join(dir, "users.parquet"));
    assert.deepEqual(await parquetReadObjects({ file }), [
      { _id: "u1", _creationTime: 1, name: "ada" },
    ]);
    store.close();
  });

  test("without --format the sync writes no files at all", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u1" })])]);
    assert.equal(existsSync(dir), false);
    store.close();
  });

  test("a later sync refreshes the file for a table that changed", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const target = { outDir: dir, format: "csv" as const };
    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u1", n: 1 })])], target);
    assert.equal(readFileSync(join(dir, "users.csv"), "utf8"), "_id,n\nu1,1\n");

    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u1", n: 2 })])], target);
    assert.equal(readFileSync(join(dir, "users.csv"), "utf8"), "_id,n\nu1,2\n");
    store.close();
  });

  test("the file is rewritten whole, so deletions disappear from it", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const target = { outDir: dir, format: "csv" as const };
    await syncWith(
      store,
      [caughtUpPage([upsert("users", { _id: "u1", n: 1 }), upsert("users", { _id: "u2", n: 2 })])],
      target,
    );
    await syncWith(
      store,
      [
        caughtUpPage([
          { component: "", table: "users", deleted: true, ts: 2n, value: { _id: "u2" } },
        ]),
      ],
      target,
    );
    assert.equal(readFileSync(join(dir, "users.csv"), "utf8"), "_id,n\nu1,1\n");
    store.close();
  });

  test("a sync that changes nothing leaves the files untouched", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const target = { outDir: dir, format: "csv" as const };
    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u1", n: 1 })])], target);
    const path = join(dir, "users.csv");
    writeFileSync(path, "sentinel");

    await syncWith(store, [caughtUpPage([])], target);
    assert.equal(readFileSync(path, "utf8"), "sentinel");
    store.close();
  });

  test("only the tables that changed are rewritten", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const target = { outDir: dir, format: "csv" as const };
    await syncWith(
      store,
      [caughtUpPage([upsert("users", { _id: "u1", n: 1 }), upsert("posts", { _id: "p1", n: 1 })])],
      target,
    );
    writeFileSync(join(dir, "posts.csv"), "sentinel");

    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u2", n: 2 })])], target);
    assert.equal(readFileSync(join(dir, "users.csv"), "utf8"), "_id,n\nu1,1\nu2,2\n");
    assert.equal(readFileSync(join(dir, "posts.csv"), "utf8"), "sentinel");
    store.close();
  });

  test("a missing file is rewritten even when nothing changed", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const target = { outDir: dir, format: "csv" as const };
    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u1", n: 1 })])], target);
    rmSync(join(dir, "users.csv"));

    await syncWith(store, [caughtUpPage([])], target);
    assert.equal(readFileSync(join(dir, "users.csv"), "utf8"), "_id,n\nu1,1\n");
    store.close();
  });

  test("a truncated table is rewritten, not left holding stale rows", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const target = { outDir: dir, format: "csv" as const };
    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u1", n: 1 })])], target);
    await runSync(
      clientServing([
        {
          ...caughtUpPage([]),
          truncates: [{ component: "", table: "users" }],
        },
      ]),
      store,
      { watch: false, intervalSeconds: 1, exportTo: target },
    );
    assert.equal(readFileSync(join(dir, "users.csv"), "utf8"), "");
    store.close();
  });

  test("component tables land in their subdirectory", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    await syncWith(
      store,
      [caughtUpPage([upsert("users", { _id: "w1", n: 1 }, "waitlist")])],
      { outDir: dir, format: "csv" },
    );
    assert.equal(readFileSync(join(dir, "waitlist", "users.csv"), "utf8"), "_id,n\nw1,1\n");
    store.close();
  });

  test("fresh rewrites tables the run did not change", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const target = { outDir: dir, format: "csv" as const };
    await syncWith(store, [caughtUpPage([upsert("users", { _id: "u1", n: 1 })])], target);
    const path = join(dir, "users.csv");
    writeFileSync(path, "sentinel");

    await syncWith(store, [caughtUpPage([])], { ...target, fresh: true });
    assert.equal(readFileSync(path, "utf8"), "_id,n\nu1,1\n");
    store.close();
  });

  test("fresh forces the first write of the run, not every watch poll", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    const path = join(dir, "users.csv");
    let calls = 0;
    const client = {
      async fetchPage() {
        calls++;
        if (calls === 1) {
          return caughtUpPage([upsert("users", { _id: "u1", n: 1 })]);
        }
        if (calls === 2) {
          // Between the first export and the second poll, stand in for an
          // outside edit: it must survive, proving fresh was consumed.
          writeFileSync(path, "sentinel");
          return caughtUpPage([]);
        }
        throw new Error("stop watching");
      },
      async listActiveSyncs() {
        return { syncs: [] };
      },
    } as unknown as DataSyncClient;

    await assert.rejects(
      runSync(client, store, {
        watch: true,
        intervalSeconds: 0.001,
        exportTo: { outDir: dir, format: "csv", fresh: true },
      }),
      /stop watching/,
    );
    assert.equal(readFileSync(path, "utf8"), "sentinel");
    store.close();
  });

  test("a run stopped by --max-pages still writes what it applied", async () => {
    const store = new Store(":memory:");
    const dir = outDir();
    await runSync(
      clientServing([
        {
          pagination: { hasMore: true, nextCursor: "c1" },
          status: { type: "snapshotting" },
          syncId: "s",
          truncates: [],
          values: [upsert("users", { _id: "u1", n: 1 })],
        },
      ]),
      store,
      { watch: false, intervalSeconds: 1, maxPages: 1, exportTo: { outDir: dir, format: "csv" } },
    );
    assert.equal(readFileSync(join(dir, "users.csv"), "utf8"), "_id,n\nu1,1\n");
    store.close();
  });
});
