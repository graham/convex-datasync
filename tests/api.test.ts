import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { ApiError, DataSyncClient } from "../src/api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Records the requests made and answers each with the next queued response.
function stubFetch(responses: { status: number; body: unknown }[]): { urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    const next = responses[index++] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(next?.body ?? null), { status: next?.status ?? 200 });
  }) as typeof fetch;
  return { urls };
}

const client = () => new DataSyncClient("https://example.convex.cloud/", "dk");

describe("getActiveSync", () => {
  test("returns the deployment's view of one sync", async () => {
    const sync = {
      syncId: "15a233f2",
      lastUpdated: 1789075557043,
      status: { type: "upToDate", totalTables: 0, numDocumentsSynced: 0, syncedTs: 1 },
    };
    const { urls } = stubFetch([{ status: 200, body: sync }]);
    assert.deepEqual(await client().getActiveSync("15a233f2"), sync);
    assert.deepEqual(urls, ["https://example.convex.cloud/api/v1/data/sync/15a233f2"]);
  });

  test("a sync the deployment no longer knows is null, not an error", async () => {
    stubFetch([
      {
        status: 404,
        body: { code: "DataSyncNotFound", message: "No active data sync with id nope." },
      },
    ]);
    assert.equal(await client().getActiveSync("nope"), null);
  });

  test("escapes the sync id into the path", async () => {
    const { urls } = stubFetch([{ status: 200, body: { syncId: "a/b", lastUpdated: 1, status: {} } }]);
    await client().getActiveSync("a/b");
    assert.deepEqual(urls, ["https://example.convex.cloud/api/v1/data/sync/a%2Fb"]);
  });

  test("other failures still surface", async () => {
    stubFetch([{ status: 403, body: { code: "Forbidden", message: "nope" } }]);
    await assert.rejects(client().getActiveSync("x"), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      return true;
    });
  });
});
