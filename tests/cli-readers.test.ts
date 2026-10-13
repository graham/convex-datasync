// `datasync status`, `export` and `list`, run as real subprocesses.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { ids, sqliteDocs, useDeployment } from "./support/harness.ts";

describe("status", () => {
  const ctx = useDeployment();

  test("with nothing synced it says to run sync", async () => {
    const result = await ctx.run(["status", "--db", ctx.path("empty.sqlite3")]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no sync state; run sync first/);
  });

  test("reports the sync, its status, the exact timestamp and per-table counts", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const result = await ctx.run(["status", "--db", db]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /syncId:\s+sync-1/);
    assert.match(result.stdout, /status:\s+upToDate/);
    assert.ok(result.stdout.includes(`syncedTs:  ${ctx.fake.currentTs}`), result.stdout);
    assert.match(result.stdout, /updated:\s+\d{4}-\d\d-\d\dT/);
    assert.match(result.stdout, /<root>\/users: 2/);
    assert.match(result.stdout, /waitlist\/users: 1/);
  });

  test("works offline: it needs no credentials and makes no request", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const before = ctx.fake.requests.length;
    const result = await ctx.run(["status", "--db", db], {
      env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined },
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(ctx.fake.requests.length, before);
  });

  test("shows tombstones kept by --keep-deleted", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--keep-deleted"]);
    ctx.fake.remove("users", "u2");
    await ctx.run(["sync", "--db", db, "--keep-deleted"]);
    const result = await ctx.run(["status", "--db", db]);
    assert.match(result.stdout, /<root>\/users: 1 \(\+1 deleted\)/);
  });

  test("finds the default database by the deployment's name", async () => {
    await ctx.run(["sync"]);
    const result = await ctx.run(["status"]);
    assert.match(result.stdout, /syncId:\s+sync-1/);
  });

  test("--prod alone cannot say which database, and says so", async () => {
    const result = await ctx.run(["status", "--prod"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--prod with status\/export needs --db <path>/);
  });

  test("--prod is fine once the database is named", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const result = await ctx.run(["status", "--prod", "--db", db]);
    assert.equal(result.code, 0, result.output);
  });
});

describe("status --remote", () => {
  const ctx = useDeployment();

  test("asks the deployment for its own view of this sync, by id", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const result = await ctx.run(["status", "--db", db, "--remote"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /server: upToDate, 8 table\(s\), 12 docs synced, consistent at ts \d+/);
    assert.match(result.stdout, /last page \d{4}-\d\d-\d\dT/);
    const get = ctx.fake.requests.find((r) => r.path === "/api/v1/data/sync/sync-1");
    assert.ok(get, "fetched GET /data/sync/{syncId}");
  });

  test("the deployment's timestamp matches the local one to the last digit", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const result = await ctx.run(["status", "--db", db, "--remote"]);
    const local = /syncedTs:\s+(\d+)/.exec(result.stdout)?.[1];
    const remote = /consistent at ts (\d+)/.exec(result.stdout)?.[1];
    assert.equal(local, String(ctx.fake.currentTs));
    assert.equal(remote, local);
  });

  test("shows per-table progress while a sync is still traversing", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--max-pages", "1"]);
    const result = await ctx.run(["status", "--db", db, "--remote"]);
    assert.match(result.stdout, /server: snapshotting, 0\/\d+ tables, 2\/12 docs \(currently <root>\/users\)/);
  });

  test("says plainly when the deployment has forgotten the sync", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    ctx.fake.expire("sync-1");
    const result = await ctx.run(["status", "--db", db, "--remote"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /sync sync-1 is no longer active/);
    assert.match(result.stdout, /--fresh/);
  });

  test("with nothing synced locally there is nothing to ask about", async () => {
    const result = await ctx.run(["status", "--db", ctx.path("empty.sqlite3"), "--remote"]);
    assert.match(result.stdout, /no sync state; run sync first/);
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("--deploy-key can be given explicitly", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const result = await ctx.run(
      ["status", "--db", db, "--remote", "--url", ctx.fake.url, "--deploy-key", ctx.fake.deployKey],
      { env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined } },
    );
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /server: upToDate/);
  });
});

describe("export", () => {
  const ctx = useDeployment();
  const sync = () => ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
  const exportTo = (...args: string[]) =>
    ctx.run(["export", "--db", ctx.path("a.sqlite3"), "--out", ctx.path("out"), ...args]);

  test("defaults to jsonl, one file per table, components in subdirectories", async () => {
    await sync();
    const result = await exportTo();
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /users\.jsonl: 2 document\(s\)/);
    assert.ok(existsSync(ctx.path("out", "waitlist", "users.jsonl")));
    assert.ok(existsSync(ctx.path("out", "videosPerGamePerDay", "btree.jsonl")));
    const lines = readFileSync(ctx.path("out", "users.jsonl"), "utf8").trim().split("\n");
    assert.deepEqual(lines.map((l) => JSON.parse(l)._id), ["u1", "u2"]);
  });

  test("with no --out it writes to ./export", async () => {
    await sync();
    await ctx.run(["export", "--db", ctx.path("a.sqlite3")]);
    assert.ok(existsSync(ctx.path("export", "users.jsonl")));
  });

  test("--format json writes one array per table", async () => {
    await sync();
    await exportTo("--format", "json");
    const docs = JSON.parse(readFileSync(ctx.path("out", "posts.json"), "utf8"));
    assert.deepEqual(docs.map((d: { _id: string }) => d._id), ["p1", "p2"]);
  });

  test("--format csv writes a header, escapes JSON cells, and leaves nulls empty", async () => {
    await sync();
    await exportTo("--format", "csv");
    const csv = readFileSync(ctx.path("out", "posts.csv"), "utf8");
    assert.equal(
      csv,
      "_id,_creationTime,body,tags,title\n" +
        'p1,1700000000000.5,first,"[""a"",""b""]",Hello\n' +
        "p2,1700000000000.5,second,[],World\n",
    );
  });

  test("--format parquet writes real parquet that another reader opens", async () => {
    await sync();
    await exportTo("--format", "parquet");
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(ctx.path("out", "games.parquet")) });
    assert.deepEqual(rows.map((r) => [r._id, r.title, r.score]), [["g1", "Portal", 9.5], ["g2", "Braid", 8.5]]);
  });

  test("exports only live documents, tombstones from --keep-deleted left out", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--keep-deleted"]);
    ctx.fake.remove("users", "u2");
    await ctx.run(["sync", "--db", db, "--keep-deleted"]);
    await exportTo();
    const lines = readFileSync(ctx.path("out", "users.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
  });

  test("is offline: no credentials, no requests", async () => {
    await sync();
    const before = ctx.fake.requests.length;
    const result = await ctx.run(["export", "--db", ctx.path("a.sqlite3"), "--out", ctx.path("out")], {
      env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined },
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(ctx.fake.requests.length, before);
  });

  test("an unknown format is refused before reading anything", async () => {
    await sync();
    const result = await exportTo("--format", "xlsx");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown format: xlsx \(expected jsonl, json, csv, parquet\)/);
    assert.ok(!existsSync(ctx.path("out")));
  });

  test("rewrites existing files with the current contents", async () => {
    await sync();
    await exportTo();
    ctx.fake.upsert("users", { _id: "u3", name: "Cy" });
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    await exportTo();
    assert.equal(readFileSync(ctx.path("out", "users.jsonl"), "utf8").trim().split("\n").length, 3);
  });
});

describe("list", () => {
  const ctx = useDeployment();

  test("shows each live sync, most recently updated first", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    await ctx.run(["sync", "--db", ctx.path("b.sqlite3"), "--tables", "users"]);
    const result = await ctx.run(["list"]);
    assert.equal(result.code, 0, result.output);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^sync-2: upToDate, 1 table\(s\), 2 docs synced, consistent at ts \d+, updated \d{4}-/);
    assert.match(lines[1]!, /^sync-1: upToDate, 8 table\(s\), 12 docs synced/);
  });

  test("active-syncs is an alias", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    const result = await ctx.run(["active-syncs"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /^sync-1: upToDate/);
  });

  test("marks the sync the local copy follows", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    await ctx.run(["sync", "--db", ctx.path("b.sqlite3"), "--tables", "users"]);
    const result = await ctx.run(["list", "--db", ctx.path("a.sqlite3")]);
    const marked = result.stdout.trim().split("\n").filter((l) => l.includes("<- this database"));
    assert.equal(marked.length, 1);
    assert.match(marked[0]!, /^sync-1:/);
  });

  test("marks the sync of a --store log copy as well", async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", ctx.path("log")]);
    const result = await ctx.run(["list", "--store", "log", "--log-dir", ctx.path("log")]);
    assert.match(result.stdout, /sync-1:.*<- this database/);
  });

  test("shows traversal progress for a sync that has not finished", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--max-pages", "1"]);
    const result = await ctx.run(["list"]);
    assert.match(result.stdout, /sync-1: snapshotting, 0\/\d+ tables, 2\/12 docs \(currently <root>\/users\)/);
  });

  test("says so when there are no syncs", async () => {
    const result = await ctx.run(["list"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /no active syncs/);
  });

  test("a sync the deployment has forgotten is not listed", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    ctx.fake.expire("sync-1");
    assert.match((await ctx.run(["list"])).stdout, /no active syncs/);
  });

  test("--limit asks for one page of that size and says when there is more", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    await ctx.run(["sync", "--db", ctx.path("b.sqlite3"), "--tables", "users"]);
    const result = await ctx.run(["list", "--limit", "1"]);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout.trim().split("\n").filter((l) => l.startsWith("sync-")).length, 1);
    assert.match(result.stdout, /more syncs exist; omit --limit to list them all/);
    const request = ctx.fake.requests.filter((r) => r.path === "/api/v1/data/list_active_syncs").at(-1)!;
    assert.equal(request.query.get("limit"), "1");
  });

  test("--limit is quiet when everything fit", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    const result = await ctx.run(["list", "--limit", "5"]);
    assert.doesNotMatch(result.stdout, /more syncs exist/);
  });

  test("without --limit it follows the deployment's pagination to the end", async () => {
    ctx.fake.addSyncs(60);
    const result = await ctx.run(["list"]);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.stdout.trim().split("\n").length, 60);
    const calls = ctx.fake.requests.filter((r) => r.path === "/api/v1/data/list_active_syncs");
    assert.equal(calls.length, 2);
    assert.ok(calls[1]!.query.get("cursor"), "the second page used the cursor from the first");
  });

  test("--limit outside 1 to 100 is refused before any request", async () => {
    for (const limit of ["0", "101", "-1", "abc", "1.5"]) {
      const result = await ctx.run(["list", `--limit=${limit}`]);
      assert.equal(result.code, 1, limit);
      assert.match(result.stderr, /invalid --limit/);
    }
    // Node's own parser refuses a bare "-1" as the next token; still an error.
    const ambiguous = await ctx.run(["list", "--limit", "-1"]);
    assert.equal(ambiguous.code, 1);
    assert.match(ambiguous.stderr, /--limit=-XYZ/);
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("an unreadable local copy only costs the marker, not the listing", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    writeFileSync(ctx.path("bad.sqlite3"), "this is not a database");
    const result = await ctx.run(["list", "--db", ctx.path("bad.sqlite3")]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /^sync-1: upToDate/m);
    assert.match(result.stderr, /could not read the local copy to mark your sync/);
    assert.doesNotMatch(result.stdout, /<- this database/);
  });

  test("a local database that does not exist yet is simply not marked", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    const result = await ctx.run(["list", "--db", ctx.path("never-created.sqlite3")]);
    assert.equal(result.code, 0, result.output);
    assert.ok(!existsSync(ctx.path("never-created.sqlite3")), "listing does not create the database");
  });

  test("needs credentials, unlike status and export", async () => {
    const result = await ctx.run(["list"], { env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined } });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no credentials/);
  });
});

describe("readers see what sync wrote", () => {
  const ctx = useDeployment();

  test("the same documents come back through sqlite, export and status", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db]);
    await ctx.run(["export", "--db", db, "--out", ctx.path("out"), "--format", "json"]);
    const exported = JSON.parse(readFileSync(ctx.path("out", "games.json"), "utf8"));
    assert.deepEqual(exported, await sqliteDocs(db, "games"));
    assert.deepEqual(ids(exported), ["g1", "g2"]);
  });
});
