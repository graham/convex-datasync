// Everything else the CLI does: help, flag validation, the two stores, and
// writing files as part of a sync.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { ids, logDocs, sqliteDocs, useDeployment } from "./support/harness.ts";

describe("help and unknown input", () => {
  const ctx = useDeployment();
  const bare = { env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined } };

  test("--help and help print the same usage, without needing credentials", async () => {
    const a = await ctx.run(["--help"], bare);
    const b = await ctx.run(["help"], bare);
    assert.equal(a.code, 0);
    assert.equal(a.stdout, b.stdout);
    for (const command of ["sync", "dry-run", "status", "list", "export"]) {
      assert.match(a.stdout, new RegExp(`datasync ${command}`));
    }
    assert.match(a.stdout, /Running datasync with no command runs sync/);
  });

  test("the usage documents every flag, including the restored table patterns", async () => {
    const { stdout } = await ctx.run(["--help"], bare);
    for (const flag of [
      "--url", "--deploy-key", "--prod", "--deployment", "--store", "--db", "--log-dir",
      "--tables", "--include-tables", "--exclude-tables", "--ignore-tables", "--components",
      "--exclude-components", "--include-columns", "--exclude-columns", "--limit", "--keep-deleted",
      "--fresh", "--fresh-export", "--watch", "--interval", "--max-pages", "--debug", "--out",
      "--format", "--help",
    ]) {
      assert.ok(stdout.includes(flag), `usage mentions ${flag}`);
    }
  });

  test("an unknown command is refused with the usage, before credentials are looked at", async () => {
    const result = await ctx.run(["frobnicate"], bare);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown command: frobnicate/);
    assert.match(result.stderr, /datasync sync/);
  });

  test("an unknown flag is refused", async () => {
    const result = await ctx.run(["sync", "--frobnicate"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option '--frobnicate'/);
  });
});

describe("a flag that does nothing for the command is an error, not silence", () => {
  const ctx = useDeployment();

  const cases: [string[], RegExp][] = [
    [["status", "--watch"], /--watch has no effect on status; it applies to sync/],
    [["status", "--tables", "x"], /--tables has no effect on status/],
    [["status", "--format", "csv"], /--format has no effect on status; it applies to sync and export/],
    [["status", "--limit", "3"], /--limit has no effect on status; it applies to list/],
    [["status", "--components", "a"], /--components has no effect on status/],
    [["status", "--keep-deleted"], /--keep-deleted has no effect on status/],
    [["export", "--tables", "x"], /--tables has no effect on export/],
    [["export", "--watch"], /--watch has no effect on export/],
    [["export", "--remote"], /--remote has no effect on export; it applies to status/],
    [["export", "--fresh-export", "--format", "csv"], /--fresh-export has no effect on export; it already rewrites every table/],
    [["export", "--deploy-key", "k"], /--deploy-key has no effect on export/],
    [["list", "--tables", "x"], /--tables has no effect on list; it applies to sync/],
    [["list", "--watch"], /--watch has no effect on list/],
    [["list", "--fresh"], /--fresh has no effect on list/],
    [["list", "--keep-deleted"], /--keep-deleted has no effect on list/],
    [["list", "--max-pages", "2"], /--max-pages has no effect on list/],
    [["list", "--out", "d"], /--out has no effect on list; it applies to sync, export/],
    [["list", "--format", "csv"], /--format has no effect on list/],
    [["list", "--remote"], /--remote has no effect on list; it applies to status/],
    [["list", "--include-tables", "x"], /--include-tables has no effect on list/],
    [["active-syncs", "--watch"], /--watch has no effect on active-syncs/],
    [["sync", "--remote"], /--remote has no effect on sync; it applies to status/],
    [["sync", "--limit", "3"], /--limit has no effect on sync; it applies to list/],
    [["sync", "--fresh-export"], /--fresh-export needs --format/],
    [["dry-run", "--watch"], /--watch has no effect on dry-run; it applies to sync/],
    [["dry-run", "--format", "csv"], /--format has no effect on dry-run; it applies to sync and export/],
    [["dry-run", "--limit", "3"], /--limit has no effect on dry-run; it applies to list/],
  ];

  for (const [args, message] of cases) {
    test(args.join(" "), async () => {
      const result = await ctx.run(args);
      assert.equal(result.code, 1, result.output);
      assert.match(result.stderr, message);
      assert.equal(ctx.fake.requests.length, 0, "refused before any request");
    });
  }

  test("flags given with `=` are caught too", async () => {
    const result = await ctx.run(["status", "--tables=users"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--tables has no effect on status/);
  });

  test("a flag a command does use is not flagged", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    for (const args of [
      ["status", "--db", ctx.path("a.sqlite3"), "--store", "sqlite"],
      ["export", "--db", ctx.path("a.sqlite3"), "--out", ctx.path("o"), "--format", "csv"],
      ["list", "--db", ctx.path("a.sqlite3"), "--limit", "5"],
    ]) {
      const result = await ctx.run(args);
      assert.equal(result.code, 0, `${args.join(" ")}\n${result.output}`);
    }
  });
});

describe("--store", () => {
  const ctx = useDeployment();
  const log = () => ctx.path("data");

  test("sqlite is the default", async () => {
    await ctx.run(["sync"]);
    assert.ok(readdirSync(ctx.dir).some((f) => f.endsWith(".sqlite3")));
    assert.ok(!readdirSync(ctx.dir).some((f) => f.endsWith(".deltalog")));
  });

  test("--store log writes cursor.json, fold.sql and parquet deltas, and no sqlite", async () => {
    const result = await ctx.run(["sync", "--store", "log", "--log-dir", log()]);
    assert.equal(result.code, 0, result.output);
    assert.ok(existsSync(ctx.path("data", "cursor.json")));
    assert.ok(existsSync(ctx.path("data", "fold.sql")));
    assert.ok(readdirSync(ctx.path("data", "_root", "users"))[0]!.endsWith(".parquet"));
    assert.ok(existsSync(ctx.path("data", "waitlist", "users")));
    assert.ok(!readdirSync(ctx.dir).some((f) => f.endsWith(".sqlite3")));
  });

  test("the log defaults to <deployment>.deltalog", async () => {
    await ctx.run(["sync", "--store", "log"]);
    assert.ok(readdirSync(ctx.dir).some((f) => f.endsWith(".deltalog")));
  });

  test("the log folds back to the same documents sqlite holds", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    await ctx.run(["sync", "--store", "log", "--log-dir", log()]);
    for (const table of ["users", "posts", "games", "youtubeVideos"]) {
      assert.deepEqual(await logDocs(log(), table), await sqliteDocs(ctx.path("a.sqlite3"), table), table);
    }
    assert.deepEqual(await logDocs(log(), "users", "waitlist"), await sqliteDocs(ctx.path("a.sqlite3"), "users", "waitlist"));
  });

  test("a rerun appends deltas rather than rewriting the old ones", async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", log()]);
    const first = readdirSync(ctx.path("data", "_root", "users"));
    const bytes = readFileSync(ctx.path("data", "_root", "users", first[0]!));
    ctx.fake.upsert("users", { _id: "u1", name: "Changed", email: "x" });
    ctx.fake.remove("users", "u2");
    const result = await ctx.run(["sync", "--store", "log", "--log-dir", log()]);
    assert.match(result.stdout, /resuming sync from saved cursor/);
    const after = readdirSync(ctx.path("data", "_root", "users"));
    assert.equal(after.length, first.length + 1);
    assert.deepEqual(readFileSync(ctx.path("data", "_root", "users", first[0]!)), bytes);
    const users = await logDocs(log(), "users");
    assert.deepEqual(ids(users), ["u1"]);
    assert.equal(users[0]?.name, "Changed");
  });

  test("status, export and list all work against the log", async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", log()]);
    const status = await ctx.run(["status", "--store", "log", "--log-dir", log()]);
    assert.match(status.stdout, /syncId:\s+sync-1/);
    assert.match(status.stdout, /<root>\/users: 2/);
    const exported = await ctx.run(["export", "--store", "log", "--log-dir", log(), "--out", ctx.path("o"), "--format", "csv"]);
    assert.equal(exported.code, 0, exported.output);
    assert.ok(existsSync(ctx.path("o", "users.csv")));
    const list = await ctx.run(["list", "--store", "log", "--log-dir", log()]);
    assert.match(list.stdout, /<- this database/);
  });

  test("--fresh clears the log and starts over", async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", log()]);
    ctx.fake.remove("users", "u2");
    const result = await ctx.run(["sync", "--store", "log", "--log-dir", log(), "--fresh"]);
    assert.match(result.stdout, /discarding local data and cursor/);
    assert.deepEqual(ids(await logDocs(log(), "users")), ["u1"]);
  });

  test("--keep-deleted keeps tombstones in the log", async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", log(), "--keep-deleted"]);
    ctx.fake.remove("users", "u2");
    await ctx.run(["sync", "--store", "log", "--log-dir", log(), "--keep-deleted"]);
    const status = await ctx.run(["status", "--store", "log", "--log-dir", log(), "--keep-deleted".slice(0, 0)].filter(Boolean));
    assert.match(status.stdout, /<root>\/users: 1/);
  });

  test("store flags that belong to the other store are refused", async () => {
    const a = await ctx.run(["sync", "--store", "log", "--db", "x.sqlite3"]);
    assert.match(a.stderr, /--db is for --store sqlite; --store log uses --log-dir/);
    const b = await ctx.run(["sync", "--log-dir", "x"]);
    assert.match(b.stderr, /--log-dir is for --store log; --store sqlite uses --db/);
    const c = await ctx.run(["sync", "--store", "mongo"]);
    assert.match(c.stderr, /unknown store: mongo \(expected sqlite or log\)/);
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("--prod with the log needs the directory named, as with --db", async () => {
    const result = await ctx.run(["status", "--prod", "--store", "log"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--prod with status\/export needs --log-dir <dir>/);
  });
});

describe("sync --format", () => {
  const ctx = useDeployment();
  const base = () => ["sync", "--db", ctx.path("a.sqlite3")];

  test("without --format a sync writes no files at all", async () => {
    await ctx.run(base());
    assert.ok(!existsSync(ctx.path("export")));
  });

  for (const format of ["jsonl", "json", "csv", "parquet"]) {
    test(`--format ${format} writes a ${format} file per table into ./export`, async () => {
      const result = await ctx.run([...base(), "--format", format]);
      assert.equal(result.code, 0, result.output);
      assert.ok(existsSync(ctx.path("export", `users.${format}`)));
      assert.ok(existsSync(ctx.path("export", "waitlist", `users.${format}`)));
      assert.match(result.stdout, new RegExp(`users\\.${format}: 2 document\\(s\\)`));
    });
  }

  test("--out chooses the directory", async () => {
    await ctx.run([...base(), "--format", "csv", "--out", ctx.path("dump")]);
    assert.ok(existsSync(ctx.path("dump", "games.csv")));
    assert.ok(!existsSync(ctx.path("export")));
  });

  test("the parquet written during sync is readable parquet", async () => {
    await ctx.run([...base(), "--format", "parquet"]);
    const rows = await parquetReadObjects({ file: await asyncBufferFromFile(ctx.path("export", "games.parquet")) });
    assert.deepEqual(rows.map((r) => r._id), ["g1", "g2"]);
  });

  test("only tables that changed are rewritten on the next run", async () => {
    await ctx.run([...base(), "--format", "csv"]);
    writeFileSync(ctx.path("export", "posts.csv"), "sentinel");
    ctx.fake.upsert("users", { _id: "u3", name: "Cy" });
    await ctx.run([...base(), "--format", "csv"]);
    assert.equal(readFileSync(ctx.path("export", "posts.csv"), "utf8"), "sentinel", "untouched table left alone");
    assert.equal(readFileSync(ctx.path("export", "users.csv"), "utf8").trim().split("\n").length, 4);
  });

  test("a run that pulls nothing new touches no files", async () => {
    await ctx.run([...base(), "--format", "csv"]);
    const before = statSync(ctx.path("export", "users.csv")).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await ctx.run([...base(), "--format", "csv"]);
    assert.equal(statSync(ctx.path("export", "users.csv")).mtimeMs, before);
  });

  test("a deleted output file is put back even when nothing changed", async () => {
    await ctx.run([...base(), "--format", "csv"]);
    writeFileSync(ctx.path("export", "posts.csv"), "sentinel");
    ctx.fake.truncate("users");
    await ctx.run([...base(), "--format", "csv"]);
    assert.equal(readFileSync(ctx.path("export", "users.csv"), "utf8"), "", "truncated table's file is emptied");
  });

  test("--fresh-export rewrites every table, changed or not", async () => {
    await ctx.run([...base(), "--format", "csv"]);
    writeFileSync(ctx.path("export", "posts.csv"), "sentinel");
    const result = await ctx.run([...base(), "--format", "csv", "--fresh-export"]);
    assert.equal(result.code, 0, result.output);
    assert.match(readFileSync(ctx.path("export", "posts.csv"), "utf8"), /^_id,/);
  });

  test("--fresh-export in a watch run forces the first write only", async () => {
    await ctx.run([...base(), "--format", "csv"]);
    writeFileSync(ctx.path("export", "posts.csv"), "sentinel");
    const cli = ctx.start([...base(), "--format", "csv", "--fresh-export", "--watch", "--interval", "0.2"]);
    await cli.waitFor(/caught up/);
    assert.match(readFileSync(ctx.path("export", "posts.csv"), "utf8"), /^_id,/, "first write is forced");
    writeFileSync(ctx.path("export", "posts.csv"), "sentinel");
    ctx.fake.upsert("users", { _id: "u8", name: "Eve" });
    await cli.waitFor(/users \+1/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    cli.signal("SIGINT");
    await cli.result();
    assert.equal(readFileSync(ctx.path("export", "posts.csv"), "utf8"), "sentinel", "later polls rewrite only what changed");
  });

  test("a stopped run still writes what it applied", async () => {
    const result = await ctx.run([...base(), "--format", "csv", "--max-pages", "1"]);
    assert.match(result.stdout, /writing export files/);
    assert.ok(existsSync(ctx.path("export", "users.csv")));
  });

  test("an unknown format is refused before any request", async () => {
    const result = await ctx.run([...base(), "--format", "xlsx"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown format: xlsx/);
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("--format works alongside --store log", async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", ctx.path("data"), "--format", "csv"]);
    assert.ok(existsSync(ctx.path("export", "users.csv")));
    assert.ok(existsSync(ctx.path("data", "cursor.json")));
  });
});
