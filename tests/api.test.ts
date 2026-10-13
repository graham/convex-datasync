import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { ApiError, DataSyncClient, parseJson } from "../src/api.ts";

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
    // syncedTs is an int64, so it comes back as a bigint.
    assert.deepEqual(await client().getActiveSync("15a233f2"), {
      ...sync,
      status: { ...sync.status, syncedTs: 1n },
    });
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

describe("parseJson", () => {
  test("keeps int64 timestamps past 2^53 exact", () => {
    const parsed = parseJson(
      '{"status":{"type":"upToDate","snapshotTs":1789075524036369486},' +
        '"values":[{"component":"","table":"t","deleted":false,"ts":1789075524036369487,"value":{"_id":"a"}}]}',
    ) as { status: { snapshotTs: bigint }; values: { ts: bigint }[] };
    assert.equal(parsed.status.snapshotTs, 1789075524036369486n);
    assert.equal(parsed.values[0]?.ts, 1789075524036369487n);
  });

  test("small timestamps become bigint too, so the type is uniform", () => {
    const parsed = parseJson('{"status":{"type":"upToDate","snapshotTs":5}}') as {
      status: { snapshotTs: bigint };
    };
    assert.equal(parsed.status.snapshotTs, 5n);
  });

  test("the active-sync view's syncedTs is exact as well", () => {
    const parsed = parseJson(
      '{"syncId":"s","lastUpdated":1789075557043,' +
        '"status":{"type":"upToDate","totalTables":0,"numDocumentsSynced":0,"syncedTs":1789075524036369486}}',
    ) as { lastUpdated: number; status: { syncedTs: bigint } };
    assert.equal(parsed.status.syncedTs, 1789075524036369486n);
    assert.equal(parsed.lastUpdated, 1789075557043);
  });

  test("fields inside a document are never converted, even when named ts", () => {
    const parsed = parseJson(
      '{"values":[{"component":"","table":"t","deleted":false,"ts":1,' +
        '"value":{"_id":"a","ts":1789075524036369486,"snapshotTs":2,"type":"stale"}}]}',
    ) as { values: { value: Record<string, unknown> }[] };
    const doc = parsed.values[0]?.value;
    assert.equal(typeof doc?.ts, "number");
    assert.equal(typeof doc?.snapshotTs, "number");
  });

  test("other numbers are left as numbers", () => {
    const parsed = parseJson('{"lastUpdated":12,"pagination":{"hasMore":true}}') as {
      lastUpdated: number;
    };
    assert.equal(parsed.lastUpdated, 12);
  });
});

describe("fetchPage", () => {
  function captureBodies(): { bodies: unknown[] } {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        '{"status":{"type":"upToDate","snapshotTs":1},"truncates":[],"values":[],' +
          '"syncId":"s","pagination":{"hasMore":true,"nextCursor":"n"}}',
      );
    }) as typeof fetch;
    return { bodies };
  }

  test("omits the cursor on the first call, as the docs say", async () => {
    const { bodies } = captureBodies();
    await client().fetchPage({ cursor: null });
    assert.deepEqual(bodies, [{}]);
  });

  test("sends the cursor and selection when there are some", async () => {
    const { bodies } = captureBodies();
    const selection = { _other: "excluded" as const, "": { _other: "included" as const } };
    await client().fetchPage({ cursor: "abc", selection });
    assert.deepEqual(bodies, [{ cursor: "abc", selection }]);
  });

  test("returns the page with exact int64 fields", async () => {
    captureBodies();
    const page = await client().fetchPage({});
    assert.equal(page.status.type, "upToDate");
    assert.equal(page.pagination.nextCursor, "n");
  });
});

describe("listActiveSyncsPage", () => {
  const upToDate = (syncId: string) => ({
    syncId,
    lastUpdated: 1,
    status: { type: "upToDate", totalTables: 1, numDocumentsSynced: 2, syncedTs: 3 },
  });

  test("passes limit and cursor as query parameters", async () => {
    const { urls } = stubFetch([
      { status: 200, body: { syncs: [], pagination: { hasMore: false, nextCursor: null } } },
    ]);
    await client().listActiveSyncsPage({ limit: 5, cursor: "c1" });
    assert.deepEqual(urls, [
      "https://example.convex.cloud/api/v1/data/list_active_syncs?limit=5&cursor=c1",
    ]);
  });

  test("sends no query string when there is nothing to say", async () => {
    const { urls } = stubFetch([
      { status: 200, body: { syncs: [], pagination: { hasMore: false, nextCursor: null } } },
    ]);
    await client().listActiveSyncsPage();
    assert.deepEqual(urls, ["https://example.convex.cloud/api/v1/data/list_active_syncs"]);
  });

  test("listActiveSyncs follows nextCursor to the end", async () => {
    const { urls } = stubFetch([
      { status: 200, body: { syncs: [upToDate("a")], pagination: { hasMore: true, nextCursor: "p2" } } },
      { status: 200, body: { syncs: [upToDate("b")], pagination: { hasMore: false, nextCursor: null } } },
    ]);
    const all = await client().listActiveSyncs();
    assert.deepEqual(all.syncs.map((s) => s.syncId), ["a", "b"]);
    assert.deepEqual(urls, [
      "https://example.convex.cloud/api/v1/data/list_active_syncs",
      "https://example.convex.cloud/api/v1/data/list_active_syncs?cursor=p2",
    ]);
  });
});

describe("ApiError", () => {
  test("tells an expired cursor from one that cannot be parsed", () => {
    assert.equal(new ApiError(400, "DataSyncCursorExpired", "x").cursorExpired, true);
    assert.equal(new ApiError(400, "InvalidDataSyncCursor", "x").cursorInvalid, true);
    assert.equal(new ApiError(400, "InvalidDataSyncCursor", "x").cursorExpired, false);
  });
});
