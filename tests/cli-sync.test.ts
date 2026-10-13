// `datasync sync`, run as a real subprocess against a fake deployment.

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { Store } from "../src/store.ts";
import { ids, sqliteDocs, sqliteTables, useDeployment } from "./support/harness.ts";

describe("sync", () => {
  const ctx = useDeployment();

  test("with no command it runs sync and copies every table, components included", async () => {
    const result = await ctx.run([]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /starting sync from scratch/);
    assert.match(result.stdout, /done: \d+ page\(s\), 12 upserted, 0 deleted/);
    const dbs = readdirSync(ctx.dir).filter((f) => f.endsWith(".sqlite3"));
    assert.equal(dbs.length, 1, "one database named after the deployment");
    const tables = await sqliteTables(ctx.path(dbs[0]!));
    assert.deepEqual(tables.sort(), [
      "authAccounts",
      "featureRequests",
      "games",
      "posts",
      "users",
      "videosPerGamePerDay/btree",
      "waitlist/users",
      "youtubeVideos",
    ]);
  });

  test("documents arrive intact", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const posts = await sqliteDocs(db, "posts");
    assert.deepEqual(posts[0], {
      _id: "p1",
      _creationTime: 1700000000000.5,
      title: "Hello",
      body: "first",
      tags: ["a", "b"],
    });
  });

  test("a sync spans several pages and follows the cursor through all of them", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const requests = ctx.fake.syncRequests();
    assert.ok(requests.length >= 6, `expected a multi-page traversal, saw ${requests.length}`);
    assert.equal((requests[0]!.body as { cursor?: string }).cursor, undefined, "first call omits the cursor");
    for (const request of requests.slice(1)) {
      assert.equal(typeof (request.body as { cursor?: string }).cursor, "string");
    }
  });

  test("rerunning is incremental: it resumes from the saved cursor and pulls only the changes", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const before = ctx.fake.syncRequests().length;

    ctx.fake.upsert("users", { _id: "u1", name: "Ada Lovelace", email: "ada@example.com" });
    ctx.fake.upsert("users", { _id: "u3", name: "Cy" });
    ctx.fake.remove("users", "u2");
    const result = await ctx.run(["sync", "--db", db]);

    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /resuming sync from saved cursor/);
    assert.match(result.stdout, /done: \d+ page\(s\), 2 upserted, 1 deleted/);
    const users = await sqliteDocs(db, "users");
    assert.deepEqual(ids(users), ["u1", "u3"]);
    assert.equal(users[0]?.name, "Ada Lovelace");
    assert.equal(ctx.fake.syncRequests().length - before <= 3, true, "no second full traversal");
  });

  test("a rerun with nothing new says so and changes nothing", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const result = await ctx.run(["sync", "--db", db]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /done: 1 page\(s\), 0 upserted, 0 deleted/);
  });

  test("a table the deployment truncates is replaced, not merged", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    ctx.fake.truncate("posts");
    ctx.fake.upsert("posts", { _id: "p9", title: "After" });
    const result = await ctx.run(["sync", "--db", db]);
    assert.match(result.stdout, /truncated posts/);
    assert.deepEqual(ids(await sqliteDocs(db, "posts")), ["p9"]);
  });

  test("--keep-deleted keeps the tombstoned row and its last value", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db, "--keep-deleted"]);
    ctx.fake.remove("users", "u2");
    await ctx.run(["sync", "--db", db, "--keep-deleted"]);
    assert.deepEqual(ids(await sqliteDocs(db, "users")), ["u1"]);
    const kept = await sqliteDocs(db, "users", "", true);
    assert.deepEqual(ids(kept), ["u1", "u2"]);
    assert.equal(kept[1]?.name, "Bob", "the last-synced value survives the tombstone");
  });

  test("without --keep-deleted a deletion removes the row", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    ctx.fake.remove("users", "u2");
    await ctx.run(["sync", "--db", db]);
    assert.deepEqual(ids(await sqliteDocs(db, "users", "", true)), ["u1"]);
  });

  test("--fresh discards local data and the cursor and starts over", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    ctx.fake.remove("users", "u2");
    const before = ctx.fake.syncRequests().length;
    const result = await ctx.run(["sync", "--db", db, "--fresh"]);
    assert.match(result.stdout, /discarding local data and cursor/);
    assert.match(result.stdout, /starting sync from scratch/);
    const first = ctx.fake.syncRequests()[before]!;
    assert.equal((first.body as { cursor?: string }).cursor, undefined);
    assert.deepEqual(ids(await sqliteDocs(db, "users")), ["u1"]);
  });

  test("--max-pages stops early, saves progress, and a rerun finishes the job", async () => {
    const db = ctx.path("app.sqlite3");
    const first = await ctx.run(["sync", "--db", db, "--max-pages", "2"]);
    assert.equal(first.code, 0, first.output);
    assert.match(first.stdout, /reached --max-pages 2; progress saved/);
    assert.equal(ctx.fake.syncRequests().length, 2);

    const second = await ctx.run(["sync", "--db", db]);
    assert.match(second.stdout, /resuming sync from saved cursor/);
    assert.equal((await sqliteTables(db)).length, 8, "every table arrived across the two runs");
  });

  test("--max-pages and --interval reject values that make no sense, before any request", async () => {
    for (const args of [["--max-pages", "0"], ["--max-pages", "abc"], ["--interval", "0"], ["--interval", "abc"]]) {
      const result = await ctx.run(["sync", "--db", ctx.path("x.sqlite3"), ...args]);
      assert.equal(result.code, 1, args.join(" "));
      assert.match(result.stderr, /invalid --(max-pages|interval)/);
    }
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("--debug logs every page with the cursor fingerprints", async () => {
    const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--debug"]);
    assert.match(result.stdout, /debug page 1 \| syncId sync-1 \| values \d+ truncates \d+/);
    assert.match(result.stdout, /status snapshotting/);
    assert.match(result.stdout, /status upToDate/);
    assert.match(result.stdout, /cursor <none> -> /);
  });

  test("--watch keeps polling, picks up new writes, and ctrl-c exits cleanly with 130", async () => {
    const db = ctx.path("app.sqlite3");
    const cli = ctx.start(["sync", "--db", db, "--watch", "--interval", "0.2"]);
    await cli.waitFor(/caught up; next poll in 0.2s/);

    // A table the initial sync never saw, so its log line is unmistakable.
    ctx.fake.upsert("notes", { _id: "n1", text: "late" });
    await cli.waitFor(/truncated notes/);
    await cli.waitFor(/notes \+1/);

    cli.signal("SIGINT");
    const result = await cli.result();
    assert.equal(result.code, 130, result.output);
    assert.match(result.stdout, /interrupted: /);
    assert.match(result.stdout, /progress is saved; run sync again/);
    assert.deepEqual(ids(await sqliteDocs(db, "notes")), ["n1"]);
  });

  test("a quiet --watch keeps polling even if the cursor repeats instead of giving up", async () => {
    ctx.fake.repeatIdleCursor = true;
    const cli = ctx.start(["sync", "--db", ctx.path("a.sqlite3"), "--watch", "--interval", "0.1"]);
    await cli.waitFor(/caught up/);
    const polls = () => (cli.stdout.match(/caught up; next poll/g) ?? []).length;
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.ok(polls() >= 3, `expected repeated idle polls, saw ${polls()}`);
    assert.doesNotMatch(cli.stdout + cli.stderr, /did not advance/);
    cli.signal("SIGINT");
    await cli.result();
  });

  test("a second ctrl-c is not needed: the first one stops a watch mid-sleep", async () => {
    const cli = ctx.start(["sync", "--db", ctx.path("a.sqlite3"), "--watch", "--interval", "3600"]);
    await cli.waitFor(/caught up; next poll in 3600s/);
    cli.signal("SIGINT");
    assert.equal((await cli.result()).code, 130);
  });

  test("selection is sent on every call so it can change between runs", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db, "--tables", "users"]);
    await ctx.run(["sync", "--db", db, "--tables", "users,posts"]);
    const selections = ctx.fake.syncRequests().map((r) => JSON.stringify((r.body as { selection?: unknown }).selection));
    assert.ok(selections.every((s) => s !== undefined));
    assert.ok(selections.some((s) => !s.includes("posts")));
    assert.ok(selections.some((s) => s.includes("posts")));
  });

  test("a table newly selected on a later run is synced from scratch; a deselected one is left as it was", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db, "--tables", "users"]);
    const added = await ctx.run(["sync", "--db", db, "--tables", "users,posts"]);
    assert.match(added.stdout, /truncated posts/);
    assert.deepEqual(ids(await sqliteDocs(db, "posts")), ["p1", "p2"]);

    ctx.fake.upsert("users", { _id: "u9", name: "Ignored" });
    await ctx.run(["sync", "--db", db, "--tables", "posts"]);
    assert.deepEqual(ids(await sqliteDocs(db, "users")), ["u1", "u2"], "deselected tables stop syncing");
    assert.deepEqual(ids(await sqliteDocs(db, "posts")), ["p1", "p2"]);
  });

  test("the timestamp it reports is the deployment's, to the last digit", async () => {
    const db = ctx.path("app.sqlite3");
    const result = await ctx.run(["sync", "--db", db]);
    assert.ok(result.stdout.includes(`consistent at ts ${ctx.fake.currentTs}`), result.stdout);
    assert.ok(ctx.fake.currentTs > BigInt(Number.MAX_SAFE_INTEGER), "the fixture really is past 2^53");
  });

  test("the cursor is stored with the data, so a new process resumes", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db, "--max-pages", "1"]);
    const store = new Store(db);
    const cursor = store.getState().cursor;
    store.close();
    assert.match(cursor ?? "", /^sync-1\|/);
  });

  test("an expired cursor stops with guidance, and --fresh recovers", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    ctx.fake.expire(ctx.fake.syncIds[0]!);
    const stale = await ctx.run(["sync", "--db", db]);
    assert.equal(stale.code, 1);
    assert.match(stale.output, /saved cursor has expired/);
    assert.match(stale.output, /--fresh/);

    const fresh = await ctx.run(["sync", "--db", db, "--fresh"]);
    assert.equal(fresh.code, 0, fresh.output);
  });

  test("a cursor the deployment cannot parse also stops with guidance", async () => {
    const db = ctx.path("app.sqlite3");
    await ctx.run(["sync", "--db", db]);
    const store = new Store(db);
    store.applyPage({
      pagination: { hasMore: true, nextCursor: "garbage" },
      status: { type: "snapshotting" },
      syncId: "x",
      truncates: [],
      values: [],
    });
    store.close();
    const result = await ctx.run(["sync", "--db", db]);
    assert.equal(result.code, 1);
    assert.match(result.output, /saved cursor is not valid/);
  });

  test("without credentials it explains what to set", async () => {
    const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3")], {
      env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no credentials: set CONVEX_URL and CONVEX_DEPLOY_KEY/);
  });

  test("a rejected deploy key is reported, not retried forever", async () => {
    const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3")], {
      env: { CONVEX_DEPLOY_KEY: "wrong" },
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /HTTP 401/);
    assert.equal(ctx.fake.syncRequests().length, 1);
  });

  test("--url and --deploy-key work as flags, not just environment", async () => {
    const result = await ctx.run(
      ["sync", "--db", ctx.path("a.sqlite3"), "--url", ctx.fake.url, "--deploy-key", ctx.fake.deployKey],
      { env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined } },
    );
    assert.equal(result.code, 0, result.output);
  });

});

describe("sync against an empty deployment", () => {
  const ctx = useDeployment(false);

  test("it finishes cleanly with nothing to copy", async () => {
    const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /done: 1 page\(s\), 0 upserted, 0 deleted/);
    assert.deepEqual(await sqliteTables(ctx.path("a.sqlite3")), []);
  });

  test("export of that empty copy says there is nothing to export", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    const result = await ctx.run(["export", "--db", ctx.path("a.sqlite3")]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /nothing to export; run sync first/);
  });
});

describe("sync into a directory that does not exist yet", () => {
  const ctx = useDeployment();

  test("the output directory for --format is created", async () => {
    const result = await ctx.run([
      "sync", "--db", ctx.path("a.sqlite3"), "--format", "jsonl", "--out", ctx.path("deep", "er"),
    ]);
    assert.equal(result.code, 0, result.output);
    assert.ok(existsSync(ctx.path("deep", "er", "users.jsonl")));
  });
});
