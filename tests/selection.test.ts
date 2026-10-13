import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Selection } from "../src/api.ts";
import {
  buildSelection,
  needsRootTables,
  parseColumnFilter,
  parseComponentFilter,
  parseTableFilter,
  tableMatches,
} from "../src/selection.ts";

const INCLUSION = new Set(["included", "excluded"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The documented schema, as rules. The deployment enforces it strictly: a bare
// "included" for a component or table is a 400 BadJsonBody, which is exactly
// how --components shipped broken once. Every selection built here has to pass.
function assertMatchesSchema(selection: unknown): asserts selection is Selection {
  assert.ok(isObject(selection), "selection is an object");
  assert.ok(INCLUSION.has(selection._other as string), "selection._other is included/excluded");
  for (const [component, componentSelection] of Object.entries(selection)) {
    if (component === "_other") {
      continue;
    }
    if (componentSelection === "excluded") {
      continue;
    }
    assert.ok(isObject(componentSelection), `component "${component}" is excluded or an object`);
    assert.ok(
      INCLUSION.has(componentSelection._other as string),
      `component "${component}" has _other`,
    );
    for (const [table, tableSelection] of Object.entries(componentSelection)) {
      if (table === "_other" || tableSelection === "excluded") {
        continue;
      }
      assert.ok(isObject(tableSelection), `table "${table}" is excluded or an object`);
      assert.ok(INCLUSION.has(tableSelection._other as string), `table "${table}" has _other`);
      for (const [column, columnSelection] of Object.entries(tableSelection)) {
        assert.ok(INCLUSION.has(columnSelection as string), `column "${column}" is included/excluded`);
      }
    }
  }
}

function build(input: Parameters<typeof buildSelection>[0]): Selection | undefined {
  const selection = buildSelection(input);
  if (selection !== undefined) {
    assertMatchesSchema(selection);
  }
  return selection;
}

describe("buildSelection", () => {
  test("no filters at all selects everything, so no selection is sent", () => {
    assert.equal(build({}), undefined);
  });

  test("an exact table list includes only those root tables", () => {
    assert.deepEqual(build({ tables: ["users", "posts"] }), {
      _other: "excluded",
      "": {
        _other: "excluded",
        users: { _other: "included" },
        posts: { _other: "included" },
      },
    });
  });

  test("uses the documented names, not the short forms", () => {
    const text = JSON.stringify(
      build({
        tables: ["a"],
        columns: parseColumnFilter(undefined, "a:b"),
        components: parseComponentFilter(undefined, "c"),
      }),
    );
    assert.doesNotMatch(text, /"incl"|"excl"/);
  });

  test("a column excluded from one named table leaves the other root tables whole", () => {
    const columns = parseColumnFilter(undefined, "games:blob");
    assert.deepEqual(build({ columns }), {
      _other: "included",
      "": { _other: "included", games: { _other: "included", blob: "excluded" } },
    });
  });

  test("table:column entries need no table list", () => {
    const columns = parseColumnFilter(undefined, "games:blob,users:email");
    assert.deepEqual(build({ columns }), {
      _other: "included",
      "": {
        _other: "included",
        games: { _other: "included", blob: "excluded" },
        users: { _other: "included", email: "excluded" },
      },
    });
  });

  test("included columns keep _id and drop the rest", () => {
    const columns = parseColumnFilter("games:title,games:score", undefined);
    assert.deepEqual(build({ columns }), {
      _other: "included",
      "": {
        _other: "included",
        games: { _other: "excluded", _id: "included", title: "included", score: "included" },
      },
    });
  });

  test("a bare column applies to each table named by --tables", () => {
    const columns = parseColumnFilter(undefined, "description");
    assert.deepEqual(build({ tables: ["games", "users"], columns }), {
      _other: "excluded",
      "": {
        _other: "excluded",
        games: { _other: "included", description: "excluded" },
        users: { _other: "included", description: "excluded" },
      },
    });
  });

  test("a bare column with nothing naming tables is refused", () => {
    const columns = parseColumnFilter(undefined, "description");
    assert.throws(() => buildSelection({ columns }), /bare column name applies to the tables/);
  });

  test("a column entry for a table outside --tables is refused", () => {
    const columns = parseColumnFilter(undefined, "users:email");
    assert.throws(() => buildSelection({ tables: ["games"], columns }), /"users" is not selected/);
  });

  test("an excluded component is the bare string, the one form the schema allows", () => {
    const components = parseComponentFilter(undefined, "waitlist");
    assert.deepEqual(build({ components }), { _other: "included", waitlist: "excluded" });
  });

  test("an included component is an object, never the bare string", () => {
    const components = parseComponentFilter("waitlist/inner", undefined);
    assert.deepEqual(build({ components }), {
      _other: "excluded",
      "waitlist/inner": { _other: "included" },
    });
  });

  test("_root names the root component", () => {
    const components = parseComponentFilter("_root", undefined);
    assert.deepEqual(build({ components }), { _other: "excluded", "": { _other: "included" } });
  });

  test("a table list wins over a bare _root include", () => {
    const components = parseComponentFilter("_root,waitlist", undefined);
    assert.deepEqual(build({ tables: ["games"], components }), {
      _other: "excluded",
      waitlist: { _other: "included" },
      "": { _other: "excluded", games: { _other: "included" } },
    });
  });

  test("excluding _root while selecting root tables is a contradiction", () => {
    const components = parseComponentFilter(undefined, "_root");
    assert.throws(() => buildSelection({ tables: ["games"], components }), /conflicts/);
  });

  test("every combination passes the schema check", () => {
    const tableSets = [null, ["games"], ["games", "users"]];
    const componentSets = [
      null,
      parseComponentFilter("waitlist", undefined),
      parseComponentFilter("_root,waitlist", undefined),
      parseComponentFilter(undefined, "waitlist"),
    ];
    const columnSets = [
      null,
      parseColumnFilter(undefined, "games:blob"),
      parseColumnFilter("games:title", undefined),
    ];
    for (const tables of tableSets) {
      for (const components of componentSets) {
        for (const columns of columnSets) {
          if (tables !== null && columns !== null && !tables.includes("games")) {
            continue;
          }
          build({ tables, components, columns });
        }
      }
    }
  });
});

describe("table filters", () => {
  const rootTables = ["authAccounts", "authSessions", "games", "users"];

  test("exclude regex skips matching tables", () => {
    const filter = parseTableFilter(undefined, "^auth")!;
    assert.equal(tableMatches("authAccounts", filter), false);
    assert.equal(tableMatches("games", filter), true);
  });

  test("include regex keeps only matching tables", () => {
    const filter = parseTableFilter("^games", undefined)!;
    assert.equal(tableMatches("games", filter), true);
    assert.equal(tableMatches("users", filter), false);
  });

  test("include and exclude combine", () => {
    const filter = parseTableFilter("^auth", "Sessions$")!;
    assert.equal(tableMatches("authAccounts", filter), true);
    assert.equal(tableMatches("authSessions", filter), false);
  });

  test("no patterns returns null", () => {
    assert.equal(parseTableFilter(undefined, undefined), null);
  });

  test("an invalid regex is reported with its flag", () => {
    assert.throws(() => parseTableFilter("[", undefined), /--include-tables/);
    assert.throws(() => parseTableFilter(undefined, "("), /--exclude-tables/);
  });

  test("exclude mode keeps everything else in, components included", () => {
    const tableFilter = parseTableFilter(undefined, "^auth");
    assert.deepEqual(build({ tableFilter, rootTables }), {
      _other: "included",
      "": { _other: "included", authAccounts: "excluded", authSessions: "excluded" },
    });
  });

  test("include mode names the matches and excludes the rest", () => {
    const tableFilter = parseTableFilter("^games$", undefined);
    assert.deepEqual(build({ tableFilter, rootTables }), {
      _other: "excluded",
      "": { _other: "excluded", games: { _other: "included" } },
    });
  });

  test("include and exclude together behave as the intersection", () => {
    const tableFilter = parseTableFilter("^auth", "Sessions$");
    assert.deepEqual(build({ tableFilter, rootTables }), {
      _other: "excluded",
      "": { _other: "excluded", authAccounts: { _other: "included" } },
    });
  });

  test("an excluded component stays excluded alongside a table filter", () => {
    const tableFilter = parseTableFilter(undefined, "^auth");
    const components = parseComponentFilter(undefined, "waitlist");
    assert.deepEqual(build({ tableFilter, rootTables, components }), {
      _other: "included",
      "": { _other: "included", authAccounts: "excluded", authSessions: "excluded" },
      waitlist: "excluded",
    });
  });

  test("a bare column applies to every table an exclude filter leaves in", () => {
    const tableFilter = parseTableFilter(undefined, "^(auth|users)");
    const columns = parseColumnFilter(undefined, "blob");
    assert.deepEqual(build({ tableFilter, rootTables, columns }), {
      _other: "included",
      "": {
        _other: "included",
        authAccounts: "excluded",
        authSessions: "excluded",
        users: "excluded",
        games: { _other: "included", blob: "excluded" },
      },
    });
  });

  test("a bare column applies to each table an include filter matched", () => {
    const tableFilter = parseTableFilter("^(games|users)$", undefined);
    const columns = parseColumnFilter(undefined, "blob");
    assert.deepEqual(build({ tableFilter, rootTables, columns }), {
      _other: "excluded",
      "": {
        _other: "excluded",
        games: { _other: "included", blob: "excluded" },
        users: { _other: "included", blob: "excluded" },
      },
    });
  });

  test("a table:column entry for a table the filter drops is refused", () => {
    const tableFilter = parseTableFilter("^games$", undefined);
    const columns = parseColumnFilter(undefined, "users:email");
    assert.throws(
      () => buildSelection({ tableFilter, rootTables, columns }),
      /"users" is not selected/,
    );
  });

  test("a table filter cannot be combined with an exact table list", () => {
    const tableFilter = parseTableFilter("^g", undefined);
    assert.throws(
      () => buildSelection({ tables: ["games"], tableFilter, rootTables }),
      /cannot be combined/,
    );
  });

  test("a table filter without the table list is a programming error, not a guess", () => {
    const tableFilter = parseTableFilter("^g", undefined);
    assert.throws(() => buildSelection({ tableFilter }), /root table list/);
  });

  test("needsRootTables is true only for a table filter", () => {
    assert.equal(needsRootTables({}), false);
    assert.equal(needsRootTables({ tables: ["games"] }), false);
    assert.equal(needsRootTables({ tableFilter: parseTableFilter("^g", undefined) }), true);
  });

  test("a filter that matches nothing still yields a valid, empty selection", () => {
    const tableFilter = parseTableFilter("^nothing$", undefined);
    assert.deepEqual(build({ tableFilter, rootTables }), {
      _other: "excluded",
      "": { _other: "excluded" },
    });
  });
});

describe("parseColumnFilter", () => {
  test("no specs returns null", () => {
    assert.equal(parseColumnFilter(undefined, undefined), null);
  });

  test("include and exclude cannot be combined", () => {
    assert.throws(() => parseColumnFilter("a:b", "c:d"), /cannot be combined/);
  });

  test("_id cannot be excluded", () => {
    assert.throws(() => parseColumnFilter(undefined, "games:_id"), /_id cannot be excluded/);
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

  test("a component in both lists is rejected", () => {
    assert.throws(() => parseComponentFilter("a,b", "b"), /in both/);
  });
});
