// The selection flags of `datasync sync`, end to end: what is sent to the
// deployment, and what lands in the local copy.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ids, sqliteDocs, sqliteTables, useDeployment } from "./support/harness.ts";

const sentSelection = (ctx: ReturnType<typeof useDeployment>) =>
  (ctx.fake.syncRequests()[0]!.body as { selection?: unknown }).selection;
const adminQueries = (ctx: ReturnType<typeof useDeployment>) =>
  ctx.fake.requests.filter((r) => r.path === "/api/query");

describe("--tables", () => {
  const ctx = useDeployment();

  test("syncs exactly the named root tables", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--tables", "users,posts"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /syncing table\(s\): users, posts/);
    assert.deepEqual((await sqliteTables(db)).sort(), ["posts", "users"]);
    assert.deepEqual(sentSelection(ctx), {
      _other: "excluded",
      "": { _other: "excluded", users: { _other: "included" }, posts: { _other: "included" } },
    });
  });

  test("tolerates spaces and empty entries", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--tables", " users , ,posts "]);
    assert.deepEqual((await sqliteTables(db)).sort(), ["posts", "users"]);
  });

  test("never touches the undocumented table-listing query", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--tables", "users"]);
    assert.equal(adminQueries(ctx).length, 0);
  });

  test("a table that does not exist simply yields nothing", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--tables", "nope"]);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(await sqliteTables(db), []);
  });
});

describe("--include-tables / --exclude-tables / --ignore-tables", () => {
  const ctx = useDeployment();

  test("--include-tables keeps only the matches", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--include-tables", "^youtube"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /syncing 1 table\(s\): youtubeVideos/);
    assert.match(result.stdout, /skipping \d+ table\(s\): .*users/);
    assert.deepEqual(await sqliteTables(db), ["youtubeVideos"]);
  });

  test("--exclude-tables drops the matches and keeps the rest, components too", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--exclude-tables", "^auth"]);
    assert.equal(result.code, 0, result.output);
    const tables = await sqliteTables(db);
    assert.ok(!tables.includes("authAccounts"));
    assert.ok(tables.includes("users") && tables.includes("waitlist/users"));
    assert.ok(tables.includes("videosPerGamePerDay/btree"));
  });

  test("--ignore-tables is an alias for --exclude-tables", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--ignore-tables", "^auth"]);
    assert.ok(!(await sqliteTables(db)).includes("authAccounts"));
  });

  test("include and exclude together intersect", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--include-tables", "^(users|posts|games)$", "--exclude-tables", "^posts$"]);
    assert.deepEqual((await sqliteTables(db)).sort(), ["games", "users"]);
  });

  test("system tables are never offered to the pattern", async () => {
    const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--include-tables", "."]);
    assert.doesNotMatch(result.stdout, /_storage|_scheduled_functions/);
  });

  test("the regexes are resolved with exactly one table-listing query", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--exclude-tables", "^auth"]);
    assert.equal(adminQueries(ctx).length, 1);
    assert.equal((adminQueries(ctx)[0]!.body as { path: string }).path, "_system/cli/tables");
  });

  test("a filter that matches nothing fails before syncing anything", async () => {
    const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--include-tables", "^nothing$"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /table filter matches no tables on the deployment/);
    assert.equal(ctx.fake.syncRequests().length, 0);
  });

  test("an invalid regex fails before any request, naming its flag", async () => {
    for (const [flag, pattern] of [["--include-tables", "["], ["--exclude-tables", "("], ["--ignore-tables", "*"]] as const) {
      const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), flag, pattern]);
      assert.equal(result.code, 1, flag);
      assert.match(result.stderr, /invalid --(include|exclude)-tables regex/);
    }
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("--tables cannot be combined with a pattern", async () => {
    for (const flag of ["--include-tables", "--exclude-tables", "--ignore-tables"]) {
      const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--tables", "users", flag, "x"]);
      assert.equal(result.code, 1, flag);
      assert.match(result.stderr, /--tables cannot be combined with --include-tables\/--exclude-tables/);
    }
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("a pattern works with an excluded component", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--exclude-tables", "^auth", "--exclude-components", "waitlist"]);
    const tables = await sqliteTables(db);
    assert.ok(!tables.includes("waitlist/users") && !tables.includes("authAccounts"));
    assert.ok(tables.includes("users"));
  });
});

describe("--components / --exclude-components", () => {
  const ctx = useDeployment();

  test("--components names the components to sync, and only those", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--components", "waitlist"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /syncing component\(s\): waitlist/);
    assert.deepEqual(await sqliteTables(db), ["waitlist/users"]);
    assert.deepEqual(sentSelection(ctx), { _other: "excluded", waitlist: { _other: "included" } });
  });

  test("_root names the root component", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--components", "_root"]);
    const tables = await sqliteTables(db);
    assert.ok(tables.includes("users") && !tables.some((t) => t.includes("/")));
  });

  test("several components, including the root", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--components", "_root,waitlist"]);
    const tables = await sqliteTables(db);
    assert.ok(tables.includes("users") && tables.includes("waitlist/users"));
    assert.ok(!tables.includes("videosPerGamePerDay/btree"));
  });

  test("--exclude-components skips only those", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--exclude-components", "videosPerGamePerDay"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /skipping component\(s\): videosPerGamePerDay/);
    const tables = await sqliteTables(db);
    assert.ok(!tables.includes("videosPerGamePerDay/btree"));
    assert.ok(tables.includes("waitlist/users") && tables.includes("users"));
    assert.deepEqual(sentSelection(ctx), { _other: "included", videosPerGamePerDay: "excluded" });
  });

  test("--exclude-components _root leaves only the components", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--exclude-components", "_root"]);
    const tables = await sqliteTables(db);
    assert.ok(tables.length > 0 && tables.every((t) => t.includes("/")), tables.join());
  });

  test("an included component is sent as an object: the server rejects the bare string", async () => {
    const result = await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--components", "waitlist"]);
    assert.equal(result.code, 0, result.output);
    assert.doesNotMatch(JSON.stringify(sentSelection(ctx)), /"waitlist":"included"/);
  });

  test("a component in both lists, or an empty list, is refused up front", async () => {
    const both = await ctx.run(["sync", "--components", "a", "--exclude-components", "a"]);
    assert.equal(both.code, 1);
    assert.match(both.stderr, /is in both --components and --exclude-components/);
    const empty = await ctx.run(["sync", "--components", " , "]);
    assert.match(empty.stderr, /--components is empty/);
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("excluding _root while selecting root tables is a contradiction", async () => {
    const result = await ctx.run(["sync", "--exclude-components", "_root", "--tables", "users"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /conflicts/);
  });
});

describe("--include-columns / --exclude-columns", () => {
  const ctx = useDeployment();

  test("--exclude-columns table:column drops it without naming any other table", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--exclude-columns", "games:description"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /dropping column\(s\): games:description/);
    const games = await sqliteDocs(db, "games");
    assert.ok(games.every((g) => !("description" in g) && "title" in g));
    const videos = await sqliteDocs(db, "youtubeVideos");
    assert.ok(videos.every((v) => "description" in v), "other tables stay whole");
    assert.equal(adminQueries(ctx).length, 0, "table:column needs no table listing");
  });

  test("--include-columns keeps only the named columns plus _id", async () => {
    const db = ctx.path("a.sqlite3");
    const result = await ctx.run(["sync", "--db", db, "--include-columns", "games:title,games:score"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /keeping only column\(s\): games:title, games:score/);
    assert.deepEqual(await sqliteDocs(db, "games"), [
      { _id: "g1", title: "Portal", score: 9.5 },
      { _id: "g2", title: "Braid", score: 8.5 },
    ]);
  });

  test("a bare column applies to each table --tables names", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--tables", "games,youtubeVideos", "--exclude-columns", "description"]);
    for (const table of ["games", "youtubeVideos"]) {
      assert.ok((await sqliteDocs(db, table)).every((d) => !("description" in d)), table);
    }
  });

  test("a bare column applies to the tables a pattern selects", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--include-tables", "^(games|youtubeVideos)$", "--exclude-columns", "description"]);
    for (const table of ["games", "youtubeVideos"]) {
      assert.ok((await sqliteDocs(db, table)).every((d) => !("description" in d)), table);
    }
    assert.deepEqual((await sqliteTables(db)).sort(), ["games", "youtubeVideos"]);
  });

  test("a bare column with nothing naming tables is refused before any request", async () => {
    const result = await ctx.run(["sync", "--exclude-columns", "description"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /bare column name applies to the tables/);
    assert.equal(ctx.fake.requests.length, 0);
  });

  test("_id cannot be excluded", async () => {
    const result = await ctx.run(["sync", "--exclude-columns", "games:_id"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /_id cannot be excluded/);
  });

  test("include and exclude cannot be combined", async () => {
    const result = await ctx.run(["sync", "--include-columns", "games:a", "--exclude-columns", "games:b"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot be combined/);
  });

  test("a malformed entry is refused", async () => {
    const result = await ctx.run(["sync", "--exclude-columns", "games:"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not a column or table:column/);
  });

  test("a column entry for a table outside --tables is an error, not a silent no-op", async () => {
    const result = await ctx.run(["sync", "--tables", "games", "--exclude-columns", "users:email"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /"users" is not selected/);
    assert.equal(ctx.fake.requests.length, 0);
  });
});

describe("the selection the deployment actually receives", () => {
  const ctx = useDeployment();

  test("is omitted entirely when nothing is restricted", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3")]);
    assert.ok(ctx.fake.syncRequests().every((r) => !("selection" in (r.body as object))));
  });

  test("every restricted selection passes the deployment's strict schema", async () => {
    const attempts = [
      ["--tables", "users"],
      ["--include-tables", "^u"],
      ["--exclude-tables", "^a"],
      ["--components", "waitlist"],
      ["--components", "_root,waitlist"],
      ["--exclude-components", "waitlist"],
      ["--exclude-columns", "games:description"],
      ["--include-columns", "games:title"],
      ["--tables", "games", "--exclude-columns", "description"],
      ["--exclude-tables", "^a", "--exclude-columns", "description"],
      ["--components", "waitlist", "--tables", "users"],
    ];
    for (const extra of attempts) {
      const result = await ctx.run(["sync", "--db", ctx.path(`${extra.join("")}.sqlite3`), ...extra]);
      assert.equal(result.code, 0, `${extra.join(" ")}\n${result.output}`);
    }
  });

  test("uses the documented names, never the undocumented short forms", async () => {
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), "--tables", "games", "--exclude-columns", "description"]);
    const body = JSON.stringify(ctx.fake.syncRequests().map((r) => r.body));
    assert.match(body, /"included"/);
    assert.doesNotMatch(body, /"incl"|"excl"/);
  });

  test("includes the component rows when only a column filter is given", async () => {
    const db = ctx.path("a.sqlite3");
    await ctx.run(["sync", "--db", db, "--exclude-columns", "games:description"]);
    assert.deepEqual(ids(await sqliteDocs(db, "users", "waitlist")), ["w1"]);
  });
});
