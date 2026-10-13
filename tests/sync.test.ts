import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { consistentTs, isCaughtUp, type DataSyncResponse } from "../src/api.ts";

function page(status: DataSyncResponse["status"]): DataSyncResponse {
  // The endpoint is an infinite stream: hasMore is always true and there is
  // always a next cursor, whatever the status.
  return {
    pagination: { hasMore: true, nextCursor: "c" },
    status,
    syncId: "s",
    truncates: [],
    values: [],
  };
}

describe("isCaughtUp", () => {
  test("upToDate ends a one-time sync", () => {
    assert.equal(isCaughtUp(page({ type: "upToDate", snapshotTs: 1n })), true);
  });

  test("snapshotting keeps going", () => {
    assert.equal(isCaughtUp(page({ type: "snapshotting" })), false);
  });

  test("stale keeps going: a consistent snapshot, but not the latest one", () => {
    assert.equal(isCaughtUp(page({ type: "stale", snapshotTs: 1n })), false);
  });

  test("hasMore is not consulted", () => {
    const done = page({ type: "snapshotting" });
    done.pagination.hasMore = false;
    assert.equal(isCaughtUp(done), false);
  });
});

describe("consistentTs", () => {
  test("upToDate and stale both carry the ts the data is consistent at", () => {
    assert.equal(consistentTs({ type: "upToDate", snapshotTs: 7n }), 7n);
    assert.equal(consistentTs({ type: "stale", snapshotTs: 6n }), 6n);
  });

  test("snapshotting has none", () => {
    assert.equal(consistentTs({ type: "snapshotting" }), null);
  });
});
