// The sync loop against a stub of the data sync endpoint, checking that it
// follows the documented protocol: stop at the first upToDate page, keep going
// through snapshotting and stale, and never read anything into hasMore.

import assert from "node:assert/strict";
import { beforeEach, describe, mock, test } from "node:test";
import { ApiError, type DataSyncArgs, type DataSyncClient, type DataSyncResponse } from "../src/api.ts";
import { Store } from "../src/store.ts";
import { runSync } from "../src/sync.ts";

function page(
  status: DataSyncResponse["status"],
  nextCursor: string,
  values: DataSyncResponse["values"] = [],
): DataSyncResponse {
  return {
    pagination: { hasMore: true, nextCursor },
    status,
    syncId: "s",
    truncates: [],
    values,
  };
}

const upToDate = (cursor: string, values: DataSyncResponse["values"] = []) =>
  page({ type: "upToDate", snapshotTs: 1n }, cursor, values);
const stale = (cursor: string) => page({ type: "stale", snapshotTs: 1n }, cursor);
const snapshotting = (cursor: string) => page({ type: "snapshotting" }, cursor);

// Answers each call from the queue; once it runs dry, `then` decides.
function stub(
  queue: DataSyncResponse[],
  then: () => DataSyncResponse = () => {
    throw new Error("queue exhausted");
  },
): { client: DataSyncClient; calls: DataSyncArgs[] } {
  const calls: DataSyncArgs[] = [];
  const client = {
    async fetchPage(args: DataSyncArgs) {
      calls.push(args);
      return queue.shift() ?? then();
    },
    async getActiveSync() {
      return null;
    },
  } as unknown as DataSyncClient;
  return { client, calls };
}

const opts = { watch: false, intervalSeconds: 0.001 };

describe("runSync protocol", () => {
  beforeEach(() => {
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
  });

  test("a one-time sync stops at the first upToDate page", async () => {
    const store = new Store(":memory:");
    const { client, calls } = stub([snapshotting("c1"), snapshotting("c2"), upToDate("c3")]);
    await runSync(client, store, opts);
    assert.equal(calls.length, 3);
    assert.equal(store.getState().cursor, "c3");
    store.close();
  });

  test("stale is not the end: it is a consistent snapshot, but not the latest", async () => {
    const store = new Store(":memory:");
    const { client, calls } = stub([stale("c1"), stale("c2"), upToDate("c3")]);
    await runSync(client, store, opts);
    assert.equal(calls.length, 3);
    store.close();
  });

  test("each call resumes from the cursor the previous page returned", async () => {
    const store = new Store(":memory:");
    const { client, calls } = stub([snapshotting("c1"), upToDate("c2")]);
    await runSync(client, store, opts);
    assert.deepEqual(
      calls.map((c) => c.cursor ?? null),
      [null, "c1"],
    );
    store.close();
  });

  test("the selection is sent on every call, so it can change between runs", async () => {
    const store = new Store(":memory:");
    const selection = { _other: "excluded" as const, "": { _other: "included" as const } };
    const { client, calls } = stub([snapshotting("c1"), upToDate("c2")]);
    await runSync(client, store, { ...opts, selection });
    assert.deepEqual(
      calls.map((c) => c.selection),
      [selection, selection],
    );
    store.close();
  });

  test("a sync that is mid-traversal does not stop just because hasMore says so", async () => {
    const store = new Store(":memory:");
    const done = snapshotting("c1");
    done.pagination.hasMore = false;
    const { client, calls } = stub([done, upToDate("c2")]);
    await runSync(client, store, opts);
    assert.equal(calls.length, 2);
    store.close();
  });

  test("idle watch polls that return the same cursor keep polling", async () => {
    const store = new Store(":memory:");
    // Once caught up with nothing new, the cursor legitimately stays put.
    const { client, calls } = stub([upToDate("same"), upToDate("same"), upToDate("same")], () => {
      throw new Error("stop polling");
    });
    await assert.rejects(runSync(client, store, { ...opts, watch: true }), /stop polling/);
    assert.equal(calls.length, 4);
    store.close();
  });

  test("a traversal whose cursor stops moving is abandoned rather than spun on", async () => {
    const store = new Store(":memory:");
    const { client, calls } = stub([snapshotting("stuck")], () => snapshotting("stuck"));
    await runSync(client, store, opts);
    assert.equal(calls.length, 2);
    store.close();
  });

  test("an unparseable cursor stops the run with guidance instead of crashing", async () => {
    const store = new Store(":memory:");
    const client = {
      async fetchPage() {
        throw new ApiError(400, "InvalidDataSyncCursor", "HTTP 400: Could not parse the data sync cursor");
      },
      async getActiveSync() {
        return null;
      },
    } as unknown as DataSyncClient;
    const saved = process.exitCode;
    await runSync(client, store, opts);
    assert.equal(process.exitCode, 1);
    process.exitCode = saved;
    store.close();
  });
});
