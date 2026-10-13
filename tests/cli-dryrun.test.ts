// `datasync dry-run`: the scope of a sync and how far the local copy is from
// the deployment, without downloading anything.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, test } from "node:test";
import { useDeployment } from "./support/harness.ts";

describe("dry-run", () => {
  const ctx = useDeployment();
  const db = () => ctx.path("a.sqlite3");
  const dry = (...args: string[]) => ctx.run(["dry-run", "--db", db(), ...args]);
  const documentRequests = () => ctx.fake.syncRequests().length;

  test("downloads nothing and writes nothing, even before a first sync", async () => {
    const result = await dry();
    assert.equal(result.code, 0, result.output);
    assert.equal(documentRequests(), 0, "no /data/sync call at all");
    assert.ok(!existsSync(db()), "does not create the local copy");
    assert.match(result.stdout, /dry run: nothing is downloaded or written/);
  });

  test("with nothing synced every table is reported as not synced yet", async () => {
    const result = await dry();
    assert.match(result.stdout, /users\s+2\s+0\s+\+2\s+not synced yet/);
    assert.match(result.stdout, /games\s+2\s+0\s+\+2\s+not synced yet/);
    assert.match(result.stdout, /\d+ table\(s\) differ; run sync to catch up/);
  });

  test("states the scope: tables, the document total, and what is skipped", async () => {
    const result = await dry();
    assert.match(result.stdout, /root tables:\s+6 of 6, 10 document\(s\)/);
    assert.match(result.stdout, /components:\s+all \(their tables cannot be counted, only synced\)/);
  });

  test("after a full sync the counts match", async () => {
    await ctx.run(["sync", "--db", db()]);
    const result = await dry();
    assert.match(result.stdout, /users\s+2\s+2\s+0\s*$/m);
    assert.match(result.stdout, /document counts match for every compared table/);
  });

  test("shows what changed on the deployment since", async () => {
    await ctx.run(["sync", "--db", db()]);
    ctx.fake.upsert("users", { _id: "u3", name: "Cy" });
    ctx.fake.upsert("users", { _id: "u4", name: "Di" });
    ctx.fake.remove("posts", "p1");
    const result = await dry();
    assert.match(result.stdout, /users\s+4\s+2\s+\+2/);
    assert.match(result.stdout, /posts\s+1\s+2\s+-1/);
    assert.match(result.stdout, /2 table\(s\) differ/);
  });

  test("reports a table that has gone from the deployment but is still held locally", async () => {
    await ctx.run(["sync", "--db", db()]);
    ctx.fake.truncate("featureRequests");
    const result = await dry();
    assert.match(result.stdout, /featureRequests\s+0\s+1\s+-1/);
  });

  test("component tables are listed but not counted", async () => {
    await ctx.run(["sync", "--db", db()]);
    const result = await dry();
    assert.match(result.stdout, /videosPerGamePerDay\/btree\s+\?\s+1\s+\?\s+component tables are not comparable/);
    assert.match(result.stdout, /waitlist\/users\s+\?\s+1/);
  });

  test("--tables narrows the scope and names tables the deployment does not have", async () => {
    const result = await dry("--tables", "users,games,nope");
    assert.match(result.stdout, /root tables:\s+2 of 6, 4 document\(s\)/);
    assert.match(result.stdout, /not on the deployment: nope/);
    assert.match(result.stdout, /skipped:\s+4 table\(s\)/);
    assert.doesNotMatch(result.stdout, /posts\s+2\s/, "an unselected table is not compared");
  });

  test("--include-tables and --exclude-tables narrow it by pattern, as sync would", async () => {
    const include = await dry("--include-tables", "^(users|posts)$");
    assert.match(include.stdout, /root tables:\s+2 of 6, 4 document\(s\)/);
    const exclude = await dry("--exclude-tables", "^auth");
    assert.match(exclude.stdout, /root tables:\s+5 of 6/);
    assert.match(exclude.stdout, /skipped:\s+1 table\(s\): authAccounts/);
    const alias = await dry("--ignore-tables", "^auth");
    assert.match(alias.stdout, /root tables:\s+5 of 6/);
  });

  test("a skipped table is shown only when the local copy still holds some of it", async () => {
    await ctx.run(["sync", "--db", db()]);
    const result = await dry("--tables", "users");
    assert.match(result.stdout, /posts\s+-\s+2\s+-\s+outside the selection, kept locally/);
    const clean = await ctx.run(["dry-run", "--db", ctx.path("none.sqlite3"), "--tables", "users"]);
    assert.doesNotMatch(clean.stdout, /outside the selection/);
  });

  test("components and columns are echoed in the scope", async () => {
    const result = await dry("--exclude-components", "waitlist", "--exclude-columns", "games:description");
    assert.match(result.stdout, /components:\s+skipping waitlist/);
    assert.match(result.stdout, /columns:\s+dropping games:description/);
    const only = await dry("--components", "waitlist");
    assert.match(only.stdout, /components:\s+only waitlist/);
    assert.match(only.stdout, /root tables:\s+0 of 6, 0 document\(s\)/, "the root is outside the selection");
  });

  test("--components _root keeps the root in scope", async () => {
    const result = await dry("--components", "_root");
    assert.match(result.stdout, /root tables:\s+6 of 6/);
  });

  test("--exclude-components _root takes the root out of scope", async () => {
    const result = await dry("--exclude-components", "_root");
    assert.match(result.stdout, /root tables:\s+0 of 6/);
  });

  test("refuses what a sync would refuse, before reporting anything", async () => {
    const result = await dry("--include-tables", "^users$", "--exclude-columns", "games:description");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /table "games" is not selected/);
    assert.doesNotMatch(result.stdout, /dry run:/);
    const conflict = await dry("--tables", "users", "--include-tables", "^u");
    assert.match(conflict.stderr, /--tables cannot be combined/);
    const bare = await dry("--exclude-columns", "description");
    assert.match(bare.stderr, /bare column name applies to the tables/);
  });

  test("a table:column for a table the pattern selects is fine", async () => {
    const result = await dry("--include-tables", "^(users|games)$", "--exclude-columns", "games:description");
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /columns:\s+dropping games:description/);
  });

  test("uses the undocumented queries and nothing that downloads", async () => {
    await dry();
    const paths = new Set(ctx.fake.requests.map((r) => r.path));
    assert.deepEqual([...paths], ["/api/query"]);
    const queried = ctx.fake.requests.map((r) => (r.body as { path: string }).path);
    assert.ok(queried.includes("_system/cli/tables") && queried.includes("_system/frontend/tableSize"));
  });

  test("works against a --store log copy", async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", ctx.path("data")]);
    const result = await ctx.run(["dry-run", "--store", "log", "--log-dir", ctx.path("data")]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, /document counts match for every compared table/);
  });

  test("needs credentials, since it asks the deployment", async () => {
    const result = await dry("--tables", "users");
    assert.equal(result.code, 0);
    const bare = await ctx.run(["dry-run", "--db", db()], { env: { CONVEX_URL: undefined, CONVEX_DEPLOY_KEY: undefined } });
    assert.equal(bare.code, 1);
    assert.match(bare.stderr, /no credentials/);
  });

  test("flags that mean nothing to it are refused", async () => {
    for (const [args, flag] of [
      [["--watch"], "--watch"],
      [["--format", "csv"], "--format"],
      [["--limit", "3"], "--limit"],
      [["--keep-deleted"], "--keep-deleted"],
      [["--remote"], "--remote"],
    ] as const) {
      const result = await dry(...args);
      assert.equal(result.code, 1, flag);
      assert.match(result.stderr, new RegExp(`${flag} has no effect on dry-run`));
    }
  });
});

describe("dry-run and sync agree on what is in scope", () => {
  const ctx = useDeployment();

  test("the tables a dry run lists as in scope are the tables the sync then copies", async () => {
    const flags = ["--exclude-tables", "^(auth|youtube)"];
    const dry = await ctx.run(["dry-run", "--db", ctx.path("a.sqlite3"), ...flags]);
    const inScope = [...dry.stdout.matchAll(/^(\w+)\s+\d+\s+0\s+\+\d+\s+not synced yet/gm)].map((m) => m[1]!).sort();
    await ctx.run(["sync", "--db", ctx.path("a.sqlite3"), ...flags]);
    const status = await ctx.run(["status", "--db", ctx.path("a.sqlite3")]);
    const synced = [...status.stdout.matchAll(/^<root>\/(\w+): \d+/gm)].map((m) => m[1]!).sort();
    assert.deepEqual(inScope, synced);
    assert.ok(inScope.length > 0);
  });
});
