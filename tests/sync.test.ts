import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isCaughtUp, type DataSyncResponse } from "../src/api.ts";

function page(
  status: DataSyncResponse["status"],
  hasMore: boolean,
): DataSyncResponse {
  return {
    pagination: { hasMore, nextCursor: "c" },
    status,
    syncId: "s",
    truncates: [],
    values: [],
  };
}

describe("isCaughtUp", () => {
  test("upToDate stops the sync even though hasMore stays true (live API)", () => {
    assert.equal(isCaughtUp(page({ type: "upToDate", snapshotTs: 1 }, true)), true);
  });

  test("snapshotting with hasMore keeps going", () => {
    assert.equal(isCaughtUp(page({ type: "snapshotting" }, true)), false);
  });

  test("synced (spec vocabulary) stops the sync", () => {
    assert.equal(isCaughtUp(page({ type: "synced", syncedTs: 1 }, true)), true);
  });

  test("hasMore false stops regardless of status", () => {
    assert.equal(isCaughtUp(page({ type: "snapshotting" }, false)), true);
  });
});

