import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toCsv } from "../src/csv.ts";
import { columnValue, deriveColumns } from "../src/tabular.ts";

describe("deriveColumns", () => {
  test("takes the union of top-level keys, _id and _creationTime first", () => {
    const columns = deriveColumns([
      { _id: "u1", _creationTime: 1, zeta: 1, alpha: "a" },
      { _id: "u2", _creationTime: 2, beta: true },
    ]);
    assert.deepEqual(columns.map((c) => c.name), [
      "_id",
      "_creationTime",
      "alpha",
      "beta",
      "zeta",
    ]);
  });

  test("leading columns are only emitted when present", () => {
    const columns = deriveColumns([{ _id: "u1", name: "a" }]);
    assert.deepEqual(columns.map((c) => c.name), ["_id", "name"]);
  });

  test("infers a scalar type per column", () => {
    const columns = deriveColumns([{ s: "a", n: 1.5, b: true }]);
    assert.deepEqual(
      columns.map((c) => [c.name, c.type]),
      [["b", "boolean"], ["n", "number"], ["s", "string"]],
    );
  });

  test("objects and arrays become json columns", () => {
    const columns = deriveColumns([{ obj: { a: 1 }, arr: [1, 2] }]);
    assert.deepEqual(
      columns.map((c) => [c.name, c.type]),
      [["arr", "json"], ["obj", "json"]],
    );
  });

  test("a column with mixed scalar types falls back to json", () => {
    const columns = deriveColumns([{ v: 1 }, { v: "two" }]);
    assert.deepEqual(columns.map((c) => c.type), ["json"]);
  });

  test("a column whose values are all null is a nullable string column", () => {
    const columns = deriveColumns([{ v: null }, { v: null }]);
    assert.deepEqual(columns.map((c) => [c.type, c.nullable]), [["string", true]]);
  });

  test("a key missing from some document makes the column nullable", () => {
    const columns = deriveColumns([{ a: 1, b: 2 }, { a: 3 }]);
    assert.deepEqual(
      columns.map((c) => [c.name, c.nullable]),
      [["a", false], ["b", true]],
    );
  });

  test("an explicit null makes the column nullable without changing its type", () => {
    const columns = deriveColumns([{ v: "x" }, { v: null }]);
    assert.deepEqual(columns.map((c) => [c.type, c.nullable]), [["string", true]]);
  });

  test("no documents yields no columns", () => {
    assert.deepEqual(deriveColumns([]), []);
  });

  test("columnValue normalizes missing and null to null", () => {
    const [column] = deriveColumns([{ v: "x" }, { v: null }, {}]);
    assert.ok(column);
    assert.equal(columnValue({ v: "x" }, column), "x");
    assert.equal(columnValue({ v: null }, column), null);
    assert.equal(columnValue({}, column), null);
  });
});

describe("toCsv", () => {
  test("writes a header row followed by one row per document", () => {
    const csv = toCsv([
      { _id: "u1", name: "ada" },
      { _id: "u2", name: "bob" },
    ]);
    assert.equal(csv, "_id,name\nu1,ada\nu2,bob\n");
  });

  test("quotes fields containing commas, quotes or newlines", () => {
    const csv = toCsv([{ v: 'a,b' }, { v: 'say "hi"' }, { v: "line1\nline2" }]);
    assert.equal(csv, 'v\n"a,b"\n"say ""hi"""\n"line1\nline2"\n');
  });

  test("missing and null values become empty fields", () => {
    const csv = toCsv([{ a: 1, b: "x" }, { a: 2, b: null }, { a: 3 }]);
    assert.equal(csv, "a,b\n1,x\n2,\n3,\n");
  });

  test("nested objects and arrays are serialized as JSON", () => {
    const csv = toCsv([{ tags: ["a", "b"], meta: { n: 1 } }]);
    assert.equal(csv, 'meta,tags\n"{""n"":1}","[""a"",""b""]"\n');
  });

  test("booleans and numbers render unquoted", () => {
    const csv = toCsv([{ ok: true, n: 1.5 }]);
    assert.equal(csv, "n,ok\n1.5,true\n");
  });

  test("an empty string is distinguishable from null", () => {
    const csv = toCsv([{ v: "" }, { v: null }]);
    assert.equal(csv, 'v\n""\n\n');
  });

  test("a column name needing quotes is escaped in the header", () => {
    const csv = toCsv([{ 'odd,name': 1 }]);
    assert.equal(csv, '"odd,name"\n1\n');
  });

  test("no documents yields an empty file", () => {
    assert.equal(toCsv([]), "");
  });
});
