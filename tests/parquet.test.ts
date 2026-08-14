import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from "hyparquet";
import { writeParquetFile } from "../src/parquet.ts";

const dir = mkdtempSync(join(tmpdir(), "datasync-parquet-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let counter = 0;

// Writes the documents to a real parquet file and reads it back with an
// independent parquet implementation (hyparquet).
async function roundTrip(docs: Record<string, unknown>[]) {
  const path = join(dir, `t${counter++}.parquet`);
  writeParquetFile(path, docs);
  const file = await asyncBufferFromFile(path);
  const metadata = await parquetMetadataAsync(file);
  const schema = metadata.schema.slice(1).map((element) => ({
    name: element.name,
    type: element.type,
    convertedType: element.converted_type,
    repetition: element.repetition_type,
  }));
  return { rows: await parquetReadObjects({ file }), schema };
}

describe("writeParquetFile", () => {
  test("round-trips documents through a real parquet file", async () => {
    const { rows } = await roundTrip([
      { _id: "u1", _creationTime: 1.5, name: "ada" },
      { _id: "u2", _creationTime: 2.5, name: "bob" },
    ]);
    assert.deepEqual(rows, [
      { _id: "u1", _creationTime: 1.5, name: "ada" },
      { _id: "u2", _creationTime: 2.5, name: "bob" },
    ]);
  });

  test("maps derived column types onto parquet types", async () => {
    const { schema } = await roundTrip([
      { _id: "u1", n: 1.5, ok: true, tags: ["a"] },
    ]);
    assert.deepEqual(schema, [
      { name: "_id", type: "BYTE_ARRAY", convertedType: "UTF8", repetition: "REQUIRED" },
      { name: "n", type: "DOUBLE", convertedType: undefined, repetition: "REQUIRED" },
      { name: "ok", type: "BOOLEAN", convertedType: undefined, repetition: "REQUIRED" },
      { name: "tags", type: "BYTE_ARRAY", convertedType: "JSON", repetition: "REQUIRED" },
    ]);
  });

  test("columns with nulls or missing keys are optional and read back as null", async () => {
    const { rows, schema } = await roundTrip([
      { _id: "u1", nick: "ada" },
      { _id: "u2", nick: null },
      { _id: "u3" },
    ]);
    assert.equal(schema[1]?.repetition, "OPTIONAL");
    assert.deepEqual(rows.map((row) => row.nick), ["ada", null, null]);
  });

  test("nested objects and arrays survive as JSON-typed columns", async () => {
    const { rows, schema } = await roundTrip([
      { _id: "u1", meta: { n: 1, deep: { x: true } }, tags: ["a", "b"] },
    ]);
    assert.equal(schema[1]?.convertedType, "JSON");
    assert.deepEqual(rows[0]?.meta, { n: 1, deep: { x: true } });
    assert.deepEqual(rows[0]?.tags, ["a", "b"]);
  });

  test("a column with mixed scalar types becomes JSON text", async () => {
    const { rows, schema } = await roundTrip([{ v: 1 }, { v: "two" }]);
    assert.equal(schema[0]?.convertedType, "JSON");
    assert.deepEqual(rows.map((row) => row.v), [1, "two"]);
  });

  test("large and fractional numbers keep full double precision", async () => {
    const { rows } = await roundTrip([
      { _creationTime: 1748029384123.456, big: Number.MAX_SAFE_INTEGER, small: 1e-9 },
    ]);
    assert.equal(rows[0]?._creationTime, 1748029384123.456);
    assert.equal(rows[0]?.big, Number.MAX_SAFE_INTEGER);
    assert.equal(rows[0]?.small, 1e-9);
  });

  test("unicode and embedded quotes survive", async () => {
    const { rows } = await roundTrip([{ v: 'héllo "wörld" 🎉\n' }]);
    assert.equal(rows[0]?.v, 'héllo "wörld" 🎉\n');
  });

  test("a table with no documents still writes a readable file", async () => {
    const { rows } = await roundTrip([]);
    assert.deepEqual(rows, []);
  });

  test("many rows round-trip (crosses page boundaries)", async () => {
    const docs = Array.from({ length: 5000 }, (_, i) => ({
      _id: `u${i}`,
      n: i,
      label: `row ${i % 7}`,
    }));
    const { rows } = await roundTrip(docs);
    assert.equal(rows.length, 5000);
    assert.deepEqual(rows[0], { _id: "u0", n: 0, label: "row 0" });
    assert.deepEqual(rows[4999], { _id: "u4999", n: 4999, label: `row ${4999 % 7}` });
  });
});
