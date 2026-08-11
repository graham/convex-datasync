import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseTableFilter, selectionFromFilter, tableMatches } from "../src/filter.ts";

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

describe("selectionFromFilter", () => {
  const tables = ["authAccounts", "authSessions", "games"];

  test("exclude mode keeps everything else included", () => {
    const filter = parseTableFilter(undefined, "^auth")!;
    assert.deepEqual(selectionFromFilter(tables, filter), {
      _other: "incl",
      "": { _other: "incl", authAccounts: "excl", authSessions: "excl" },
    });
  });

  test("include mode excludes everything else", () => {
    const filter = parseTableFilter("^games$", undefined)!;
    assert.deepEqual(selectionFromFilter(tables, filter), {
      _other: "excl",
      "": { _other: "excl", games: { _other: "incl" } },
    });
  });
});
