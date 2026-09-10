import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DataSyncResponse } from "../src/api.ts";
import { collect } from "../src/datastore.ts";
import { Store } from "../src/store.ts";

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

function doc(id: string, fields: Record<string, unknown> = {}) {
  return { _id: id, _creationTime: 1, ...fields };
}

describe("Store.applyPage", () => {
  test("upserts documents and persists the cursor atomically", async () => {
    const store = new Store(":memory:");
    const stats = store.applyPage(
      page({
        values: [
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u1", { name: "a" }) },
          { component: "", table: "users", deleted: false, ts: 11, value: doc("u2", { name: "b" }) },
        ],
      }),
    );
    assert.equal(stats.upserted, 2);
    assert.equal(store.getState().cursor, "cursor-1");
    assert.equal(store.getState().syncId, "sync-1");
    assert.deepEqual((await collect(store.readTable("", "users"))).map((d) => d._id), ["u1", "u2"]);
    store.close();
  });

  test("later revision of the same _id replaces the document", async () => {
    const store = new Store(":memory:");
    store.applyPage(
      page({
        values: [
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u1", { name: "old" }) },
        ],
      }),
    );
    store.applyPage(
      page({
        pagination: { hasMore: false, nextCursor: "cursor-2" },
        values: [
          { component: "", table: "users", deleted: false, ts: 20, value: doc("u1", { name: "new" }) },
        ],
      }),
    );
    const docs = (await collect(store.readTable("", "users")));
    assert.equal(docs.length, 1);
    assert.equal(docs[0]?.name, "new");
    assert.equal(store.getState().cursor, "cursor-2");
    store.close();
  });

  test("tombstones delete documents", async () => {
    const store = new Store(":memory:");
    store.applyPage(
      page({
        values: [
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u1") },
        ],
      }),
    );
    const stats = store.applyPage(
      page({
        values: [{ component: "", table: "users", deleted: true, ts: 20, value: { _id: "u1" } }],
      }),
    );
    assert.equal(stats.deleted, 1);
    assert.equal((await collect(store.readTable("", "users"))).length, 0);
    store.close();
  });

  test("truncates apply before values in the same page", async () => {
    const store = new Store(":memory:");
    store.applyPage(
      page({
        values: [
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u1") },
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u2") },
        ],
      }),
    );
    store.applyPage(
      page({
        truncates: [{ component: "", table: "users" }],
        values: [
          { component: "", table: "users", deleted: false, ts: 30, value: doc("u3") },
        ],
      }),
    );
    assert.deepEqual((await collect(store.readTable("", "users"))).map((d) => d._id), ["u3"]);
    store.close();
  });

  test("truncate only affects the matching component", async () => {
    const store = new Store(":memory:");
    store.applyPage(
      page({
        values: [
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u1") },
          { component: "waitlist", table: "users", deleted: false, ts: 10, value: doc("w1") },
        ],
      }),
    );
    store.applyPage(page({ truncates: [{ component: "waitlist", table: "users" }] }));
    assert.equal((await collect(store.readTable("", "users"))).length, 1);
    assert.equal((await collect(store.readTable("waitlist", "users"))).length, 0);
    store.close();
  });

  test("synced status records syncedTs as a string (int64-safe)", async () => {
    const store = new Store(":memory:");
    store.applyPage(page({ status: { type: "synced", syncedTs: 1234 } }));
    const state = store.getState();
    assert.equal(state.statusType, "synced");
    assert.equal(state.syncedTs, "1234");
    store.close();
  });

  test("upToDate status (live API vocabulary) records snapshotTs", async () => {
    const store = new Store(":memory:");
    store.applyPage(page({ status: { type: "upToDate", snapshotTs: 5678 } }));
    const state = store.getState();
    assert.equal(state.statusType, "upToDate");
    assert.equal(state.syncedTs, "5678");
    store.close();
  });

  test("keepDeleted marks rows instead of removing them, preserving the value", async () => {
    const store = new Store(":memory:", { keepDeleted: true });
    store.applyPage(
      page({
        values: [
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u1", { name: "a" }) },
        ],
      }),
    );
    store.applyPage(
      page({
        values: [{ component: "", table: "users", deleted: true, ts: 20, value: { _id: "u1" } }],
      }),
    );
    assert.equal((await collect(store.readTable("", "users"))).length, 0);
    const kept = (await collect(store.readTable("", "users", true)));
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.name, "a");
    const stats = (await store.tableStats());
    assert.equal(stats[0]?.documents, 0);
    assert.equal(stats[0]?.deletedDocuments, 1);
    store.close();
  });

  test("keepDeleted re-upsert clears the deleted flag", async () => {
    const store = new Store(":memory:", { keepDeleted: true });
    store.applyPage(
      page({
        values: [
          { component: "", table: "users", deleted: false, ts: 10, value: doc("u1") },
          { component: "", table: "users", deleted: true, ts: 20, value: { _id: "u1" } },
          { component: "", table: "users", deleted: false, ts: 30, value: doc("u1", { back: true }) },
        ],
      }),
    );
    const docs = (await collect(store.readTable("", "users")));
    assert.equal(docs.length, 1);
    assert.equal(docs[0]?.back, true);
    store.close();
  });

  test("keepDeleted records tombstones for documents never synced", async () => {
    const store = new Store(":memory:", { keepDeleted: true });
    store.applyPage(
      page({
        values: [{ component: "", table: "users", deleted: true, ts: 20, value: { _id: "ghost" } }],
      }),
    );
    const kept = (await collect(store.readTable("", "users", true)));
    assert.deepEqual(kept, [{ _id: "ghost" }]);
    store.close();
  });

  test("reset clears documents and state", async () => {
    const store = new Store(":memory:");
    store.applyPage(
      page({
        values: [{ component: "", table: "users", deleted: false, ts: 10, value: doc("u1") }],
      }),
    );
    store.reset();
    assert.equal(store.getState().cursor, null);
    assert.equal((await store.tableStats()).length, 0);
    store.close();
  });

  test("rejects documents without a string _id and rolls back the page", async () => {
    const store = new Store(":memory:");
    store.applyPage(
      page({
        values: [{ component: "", table: "users", deleted: false, ts: 10, value: doc("u1") }],
      }),
    );
    assert.throws(
      () =>
        store.applyPage(
          page({
            pagination: { hasMore: true, nextCursor: "cursor-bad" },
            values: [
              { component: "", table: "users", deleted: false, ts: 20, value: doc("u2") },
              { component: "", table: "users", deleted: false, ts: 20, value: { name: "no id" } },
            ],
          }),
        ),
      /no string _id/,
    );
    // The failed page must not have been partially applied.
    assert.equal(store.getState().cursor, "cursor-1");
    assert.deepEqual((await collect(store.readTable("", "users"))).map((d) => d._id), ["u1"]);
    store.close();
  });
});
