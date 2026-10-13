// The README is part of the product, so its examples are tests: every
// `datasync ...` line in it is run, as written, against a fake deployment, and
// has to do what the surrounding text says. The library snippet and the fold
// query are run too, and the README is checked against `--help` in both
// directions so neither can drift from the other.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { foldQuery } from "../src/deltalog.ts";
import { ids, logDocs, sqliteDocs, sqliteTables, useDeployment, type Context } from "./support/harness.ts";
import { CLI, cliEnv } from "./support/run-cli.ts";

const ROOT = join(import.meta.dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

interface Block {
  lang: string;
  body: string;
}

const blocks: Block[] = [...README.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => ({
  lang: m[1] ?? "",
  body: m[2] ?? "",
}));

// Splits a shell line the way the examples are written: whitespace-separated,
// quotes grouping, an unquoted # starting a comment.
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === "#" && !started && current === "") {
      break;
    } else if (/\s/.test(ch)) {
      if (started || current !== "") tokens.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started || current !== "") tokens.push(current);
  return tokens;
}

const examples: string[][] = blocks
  .filter((b) => b.lang === "sh")
  .flatMap((b) => b.body.split("\n"))
  .map((line) => line.trim())
  .filter((line) => line.startsWith("datasync "))
  .map((line) => tokenize(line).slice(1));

const label = (args: string[]) => `datasync ${args.join(" ")}`;

// Credentials in the README come from `--prod` / `--deployment`, which go
// through a `convex login` session the tests do not have. The fake takes
// credentials from the environment instead, so those two flags are dropped and
// everything else is run exactly as written.
function withoutLoginFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prod") continue;
    if (args[i] === "--deployment") {
      i++;
      continue;
    }
    out.push(args[i]!);
  }
  return out;
}

const flagValue = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

// What each example promises, beyond "it runs". Keyed by the example as written.
const promises: Record<string, (ctx: Context, args: string[]) => Promise<void>> = {
  "sync --tables users,posts": async (ctx) => {
    assert.deepEqual((await sqliteTables(dbOf(ctx))).sort(), ["posts", "users"]);
  },
  "sync --exclude-tables=^auth": async (ctx) => {
    const tables = await sqliteTables(dbOf(ctx));
    assert.ok(!tables.includes("authAccounts") && tables.includes("users"));
  },
  "sync --include-tables=^youtube": async (ctx) => {
    assert.deepEqual(await sqliteTables(dbOf(ctx)), ["youtubeVideos"]);
  },
  "sync --exclude-columns youtubeVideos:description": async (ctx) => {
    assert.ok((await sqliteDocs(dbOf(ctx), "youtubeVideos")).every((d) => !("description" in d)));
    assert.ok((await sqliteDocs(dbOf(ctx), "games")).every((d) => "description" in d));
  },
  "sync --tables games --include-columns title,score": async (ctx) => {
    for (const doc of await sqliteDocs(dbOf(ctx), "games")) {
      assert.deepEqual(Object.keys(doc).sort(), ["_id", "score", "title"]);
    }
  },
  "sync --exclude-components videosPerGamePerDay": async (ctx) => {
    assert.ok(!(await sqliteTables(dbOf(ctx))).includes("videosPerGamePerDay/btree"));
  },
  "sync --include-tables=^youtube --exclude-columns description": async (ctx) => {
    assert.deepEqual(await sqliteTables(dbOf(ctx)), ["youtubeVideos"]);
    assert.ok((await sqliteDocs(dbOf(ctx), "youtubeVideos")).every((d) => !("description" in d)));
  },
  "sync --include-columns games:title,games:score": async (ctx) => {
    for (const doc of await sqliteDocs(dbOf(ctx), "games")) {
      assert.deepEqual(Object.keys(doc).sort(), ["_id", "score", "title"]);
    }
  },
  "sync --tables games,users --exclude-columns description": async (ctx) => {
    assert.deepEqual((await sqliteTables(dbOf(ctx))).sort(), ["games", "users"]);
    assert.ok((await sqliteDocs(dbOf(ctx), "games")).every((d) => !("description" in d)));
  },
  "sync --components _root,waitlist": async (ctx) => {
    const tables = await sqliteTables(dbOf(ctx));
    assert.ok(tables.includes("users") && tables.includes("waitlist/users"));
    assert.ok(!tables.includes("videosPerGamePerDay/btree"));
  },
  "sync --keep-deleted": async (ctx) => {
    assert.ok(existsSync(dbOf(ctx)));
  },
  "sync --max-pages 100": async (ctx) => {
    assert.equal((await sqliteTables(dbOf(ctx))).length, 8);
  },
};

function dbOf(ctx: Context): string {
  const dbs = readdirSync(ctx.dir).filter((f) => f.endsWith(".sqlite3"));
  assert.equal(dbs.length, 1, `exactly one database, saw ${dbs.join()}`);
  return join(ctx.dir, dbs[0]!);
}

describe("every datasync example in the README", () => {
  const ctx = useDeployment();
  const promisesRun = new Set<string>();

  test("the README has examples for every command", () => {
    const commands = new Set(examples.map((a) => a[0]));
    for (const command of ["sync", "dry-run", "status", "list", "export", "help"]) {
      assert.ok(commands.has(command), `an example of ${command}`);
    }
    assert.ok(examples.length >= 40, `found ${examples.length} examples`);
  });

  for (const example of examples) {
    const args = withoutLoginFlags(example);
    const [command] = args;
    const key = example.join(" ");

    test(label(example), async () => {
      // Commands that read an existing copy need one to read.
      if (command === "status" || command === "export" || command === "list" || command === "dry-run") {
        const store = flagValue(args, "--store");
        const logDir = flagValue(args, "--log-dir");
        const prime = ["sync", ...(store ? ["--store", store] : []), ...(logDir ? ["--log-dir", logDir] : [])];
        const primed = await ctx.run(prime);
        assert.equal(primed.code, 0, `priming ${prime.join(" ")}\n${primed.output}`);
      }

      if (args.includes("--watch")) {
        const cli = ctx.start(args.map((a) => (a === "30" && args[args.indexOf(a) - 1] === "--interval" ? "0.2" : a)));
        await cli.waitFor(/caught up; next poll/);
        cli.signal("SIGINT");
        const result = await cli.result();
        assert.equal(result.code, 130, result.output);
        assert.match(result.stdout, /interrupted: /);
      } else {
        const result = await ctx.run(args);
        assert.equal(result.code, 0, `${label(example)}\n${result.output}`);
        assert.doesNotMatch(result.output, /has no effect|unknown (option|command|format)/i);

        if (command === "help") assert.match(result.stdout, /datasync - incremental Convex deployment data sync/);
        if (command === "sync") assert.match(result.stdout, /done: \d+ page\(s\)/);
        if (command === "status") assert.match(result.stdout, /syncId:\s+sync-1/);
        if (command === "dry-run") assert.match(result.stdout, /dry run: nothing is downloaded or written/);
        if (command === "list") assert.match(result.stdout, /sync-1: /);
        if (args.includes("--remote")) assert.match(result.stdout, /server: upToDate/);
        if (args.includes("--limit")) {
          assert.ok(result.stdout.split("\n").filter((l) => l.startsWith("sync-")).length <= Number(flagValue(args, "--limit")));
        }
      }

      // The files an example says it writes are there.
      const format = flagValue(args, "--format");
      if (format && (command === "sync" || command === "export")) {
        const out = flagValue(args, "--out") ?? "export";
        assert.ok(existsSync(join(ctx.dir, out, `users.${format}`)), `${out}/users.${format}`);
        assert.ok(existsSync(join(ctx.dir, out, "waitlist", `users.${format}`)), "components nest");
      }
      if (args.includes("--store") && flagValue(args, "--store") === "log" && command === "sync") {
        const dir = flagValue(args, "--log-dir") ?? readdirSync(ctx.dir).find((f) => f.endsWith(".deltalog"))!;
        assert.ok(existsSync(join(ctx.dir, dir, "cursor.json")), "cursor.json");
        assert.deepEqual(ids(await logDocs(join(ctx.dir, dir), "users")), ["u1", "u2"]);
      }

      const promise = promises[key];
      if (promise) {
        promisesRun.add(key);
        await promise(ctx, args);
      }
    });
  }

  test("every promise above matched an example as the README writes it", () => {
    const orphaned = Object.keys(promises).filter((k) => !promisesRun.has(k));
    assert.deepEqual(orphaned, [], "keys that no README example produced, so their checks never ran");
  });
});

describe("the library example", () => {
  const ctx = useDeployment();

  test("runs as written and prints the synced documents", async () => {
    const block = blocks.find((b) => b.lang === "ts" && b.body.includes('from "datasync"'));
    assert.ok(block, "the README has a TypeScript example");
    const source = block.body.replace('from "datasync"', `from ${JSON.stringify(join(ROOT, "src", "index.ts"))}`);
    const file = join(ctx.dir, "example.ts");
    writeFileSync(file, source);

    const child = spawn(process.execPath, [file], { cwd: ctx.dir, env: cliEnv(ctx.fake, ctx.dir) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `${out}${err}`);
    assert.match(out, /u1 \{/);
    assert.match(out, /u2 \{/);
    assert.ok(readdirSync(ctx.dir).some((f) => f.endsWith(".sqlite3")), "the store it named was created");
  });
});

describe("the fold query in the README", () => {
  const ctx = useDeployment();
  const strip = (sql: string) =>
    sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

  test("is the query the log ships as fold.sql", async () => {
    const block = blocks.find((b) => b.lang === "sql");
    assert.ok(block, "the README shows the fold query");
    assert.equal(strip(block.body), strip(foldQuery("<table>/*.parquet")));
    await ctx.run(["sync", "--store", "log", "--log-dir", join(ctx.dir, "data")]);
    assert.equal(strip(readFileSync(join(ctx.dir, "data", "fold.sql"), "utf8")), strip(block.body));
  });

  const duckdb = spawnSync("duckdb", ["--version"]).status === 0;
  test("returns the documents sqlite holds, when run by an independent engine", { skip: !duckdb && "duckdb not installed" }, async () => {
    await ctx.run(["sync", "--store", "log", "--log-dir", join(ctx.dir, "data")]);
    ctx.fake.upsert("users", { _id: "u1", name: "Changed", extra: "new column" });
    ctx.fake.remove("users", "u2");
    await ctx.run(["sync", "--store", "log", "--log-dir", join(ctx.dir, "data")]);
    const block = blocks.find((b) => b.lang === "sql")!;
    const sql = block.body.replaceAll("<table>/*.parquet", join(ctx.dir, "data", "_root", "users", "*.parquet"));
    const ran = spawnSync("duckdb", ["-json", "-c", sql], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    const rows = JSON.parse(ran.stdout) as { _id: string; name: string; extra: string | null }[];
    assert.deepEqual(rows.map((r) => r._id), ["u1"]);
    assert.equal(rows[0]?.name, "Changed");
    assert.equal(rows[0]?.extra, "new column");
  });
});

describe("the README and --help agree", () => {
  const ctx = useDeployment();
  // Link targets like (#parquet-all-the-way-down---store-log) are anchors, not flags.
  const flagsIn = (text: string) =>
    new Set(
      [...text.replace(/\(#[^)]*\)/g, "").matchAll(/--([a-zA-Z][a-zA-Z-]*)/g)].map((m) => m[1]!),
    );

  test("every flag in --help is documented in the README, and nothing else is claimed", async () => {
    const help = (await ctx.run(["--help"])).stdout;
    const documented = flagsIn(README);
    const real = flagsIn(help);
    for (const flag of real) {
      assert.ok(documented.has(flag), `--${flag} is in --help but not the README`);
    }
    // Flags in the README that are other tools' own: the Development section's
    // `node --test` and `tsc --noEmit` comments.
    const notOurs = new Set(["test", "noEmit"]);
    for (const flag of documented) {
      if (notOurs.has(flag)) continue;
      assert.ok(real.has(flag), `--${flag} is in the README but not --help`);
    }
  });

  test("every command in --help has a section in the README", async () => {
    for (const command of ["sync", "dry-run", "status", "list", "export"]) {
      assert.match(README, new RegExp(`^### ${command}`, "m"), `a ### ${command} section`);
    }
  });
});

describe("the development and install commands in the README", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    bin: Record<string, string>;
  };

  test("every `npm run X` it mentions is a real script", () => {
    const mentioned = [...README.matchAll(/npm run (\w+)/g)].map((m) => m[1]!);
    assert.ok(mentioned.length > 0);
    for (const script of mentioned) {
      assert.ok(script in pkg.scripts, `npm run ${script}`);
    }
  });

  test("the `datasync` command it tells you to link exists as a bin", () => {
    assert.equal(pkg.bin.datasync, "./dist/cli.js");
  });

  test("the CLI the examples drive is the one being tested", () => {
    assert.ok(existsSync(CLI));
  });
});
