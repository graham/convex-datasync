import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildSelection,
  needsRootTables,
  parseColumnFilter,
  parseComponentFilter,
  parseTableFilter,
  tableMatches,
} from "../src/filter.ts";

describe("tableMatches", () => {
  test("exclude regex skips matching tables", () => {
    const filter = parseTableFilter(undefined, "^auth")!;
    assert.equal(tableMatches("authAccounts", filter), false);
    assert.equal(tableMatches("games", filter), true);
  });

  test("include regex keeps only matching tables", () => {
    const filter = parseTableFilter("^youtube", undefined)!;
    assert.equal(tableMatches("youtubeVideos", filter), true);
    assert.equal(tableMatches("games", filter), false);
  });

  test("include and exclude combine", () => {
    const filter = parseTableFilter("^youtube", "Cursor$")!;
    assert.equal(tableMatches("youtubeVideos", filter), true);
    assert.equal(tableMatches("youtubeChannelCursor", filter), false);
  });

  test("no patterns returns null", () => {
    assert.equal(parseTableFilter(undefined, undefined), null);
  });

  test("invalid regex throws with the flag name", () => {
    assert.throws(() => parseTableFilter("[", undefined), /--include-tables/);
  });
});

describe("buildSelection", () => {
  const tables = ["authAccounts", "authSessions", "games"];

  test("no filters at all selects everything, so no selection is sent", () => {
    assert.equal(buildSelection({}), undefined);
  });

  test("an exact table list includes only those root tables", () => {
    assert.deepEqual(buildSelection({ tables: ["users", "posts"] }), {
      _other: "excl",
      "": { _other: "excl", users: { _other: "incl" }, posts: { _other: "incl" } },
    });
  });

  test("exclude regex keeps everything else, components included", () => {
    const tableFilter = parseTableFilter(undefined, "^auth");
    assert.deepEqual(buildSelection({ rootTables: tables, tableFilter }), {
      _other: "incl",
      "": { _other: "incl", authAccounts: "excl", authSessions: "excl" },
    });
  });

  test("include regex excludes everything else", () => {
    const tableFilter = parseTableFilter("^games$", undefined);
    assert.deepEqual(buildSelection({ rootTables: tables, tableFilter }), {
      _other: "excl",
      "": { _other: "excl", games: { _other: "incl" } },
    });
  });

  test("excluded columns are dropped from every root table", () => {
    const columns = parseColumnFilter(undefined, "description");
    assert.deepEqual(buildSelection({ rootTables: ["games", "users"], columns }), {
      _other: "incl",
      "": {
        _other: "incl",
        games: { _other: "incl", description: "excl" },
        users: { _other: "incl", description: "excl" },
      },
    });
  });

  test("a table-scoped column only affects that table", () => {
    const columns = parseColumnFilter(undefined, "games:blob");
    assert.deepEqual(buildSelection({ rootTables: ["games", "users"], columns }), {
      _other: "incl",
      "": { _other: "incl", games: { _other: "incl", blob: "excl" } },
    });
  });

  test("included columns keep _id and drop the rest", () => {
    const columns = parseColumnFilter("title,score", undefined);
    assert.deepEqual(buildSelection({ rootTables: ["games"], columns }), {
      _other: "incl",
      "": { _other: "incl", games: { _other: "excl", _id: "incl", title: "incl", score: "incl" } },
    });
  });

  test("a table no include-columns entry names keeps all its columns", () => {
    const columns = parseColumnFilter("games:title", undefined);
    assert.deepEqual(buildSelection({ rootTables: ["games", "users"], columns }), {
      _other: "incl",
      "": { _other: "incl", games: { _other: "excl", _id: "incl", title: "incl" } },
    });
  });

  test("column filters compose with an exact table list", () => {
    const columns = parseColumnFilter(undefined, "blob");
    assert.deepEqual(buildSelection({ tables: ["games"], columns }), {
      _other: "excl",
      "": { _other: "excl", games: { _other: "incl", blob: "excl" } },
    });
  });

  test("excluded components are turned off by path", () => {
    const components = parseComponentFilter(undefined, "waitlist");
    assert.deepEqual(buildSelection({ components }), { _other: "incl", waitlist: "excl" });
  });

  test("included components exclude every other component and the root", () => {
    const components = parseComponentFilter("waitlist/inner", undefined);
    assert.deepEqual(buildSelection({ components }), {
      _other: "excl",
      "waitlist/inner": "incl",
    });
  });

  test("_root names the root component", () => {
    const components = parseComponentFilter("_root", undefined);
    assert.deepEqual(buildSelection({ components }), { _other: "excl", "": "incl" });
  });

  test("a table selection wins over a bare _root include", () => {
    const components = parseComponentFilter("_root,waitlist", undefined);
    assert.deepEqual(buildSelection({ tables: ["games"], components }), {
      _other: "excl",
      waitlist: "incl",
      "": { _other: "excl", games: { _other: "incl" } },
    });
  });

  test("needsRootTables only when a table list cannot stand in", () => {
    assert.equal(needsRootTables({}), false);
    assert.equal(needsRootTables({ tables: ["games"] }), false);
    assert.equal(
      needsRootTables({ tables: ["games"], columns: parseColumnFilter(undefined, "blob") }),
      false,
    );
    assert.equal(needsRootTables({ columns: parseColumnFilter(undefined, "blob") }), true);
    assert.equal(needsRootTables({ tableFilter: parseTableFilter("^g", undefined) }), true);
  });

  test("buildSelection refuses to guess when it needs the table list", () => {
    assert.throws(
      () => buildSelection({ columns: parseColumnFilter(undefined, "blob") }),
      /root table list/,
    );
  });
});

describe("parseColumnFilter", () => {
  test("no specs returns null", () => {
    assert.equal(parseColumnFilter(undefined, undefined), null);
  });

  test("include and exclude cannot be combined", () => {
    assert.throws(() => parseColumnFilter("a", "b"), /cannot be combined/);
  });

  test("_id cannot be excluded", () => {
    assert.throws(() => parseColumnFilter(undefined, "_id"), /_id cannot be excluded/);
  });

  test("rejects a malformed entry", () => {
    assert.throws(() => parseColumnFilter(undefined, "games:"), /not a column or table:column/);
  });

  test("splits bare and table-scoped entries", () => {
    const filter = parseColumnFilter(undefined, "blob, games:title ,users:email");
    assert.deepEqual([...(filter?.all ?? [])], ["blob"]);
    assert.deepEqual([...(filter?.byTable.get("games") ?? [])], ["title"]);
    assert.deepEqual([...(filter?.byTable.get("users") ?? [])], ["email"]);
  });
});

describe("parseComponentFilter", () => {
  test("no specs returns null", () => {
    assert.equal(parseComponentFilter(undefined, undefined), null);
  });

  test("an empty list is rejected", () => {
    assert.throws(() => parseComponentFilter(" , ", undefined), /--components is empty/);
  });
});
