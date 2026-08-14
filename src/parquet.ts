// Apache Parquet output, via hyparquet-writer (pure JS, no native deps).
//
// Columns come from the same schemaless derivation the CSV writer uses. Numbers
// are written as DOUBLE because Convex numbers are IEEE-754 doubles, and json
// columns use the JSON logical type (a UTF-8 byte array holding the serialized
// value), which is what readers expect for nested data stored as text.

import { parquetWriteFile } from "hyparquet-writer";
import { columnValue, deriveColumns, type ColumnType } from "./tabular.ts";

const PARQUET_TYPES: Record<ColumnType, "BOOLEAN" | "DOUBLE" | "STRING" | "JSON"> = {
  boolean: "BOOLEAN",
  number: "DOUBLE",
  string: "STRING",
  json: "JSON",
};

export function writeParquetFile(path: string, docs: Iterable<Record<string, unknown>>): void {
  const rows = [...docs];
  const columns = deriveColumns(rows);
  parquetWriteFile({
    filename: path,
    columnData: columns.map((column) => ({
      name: column.name,
      data: rows.map((doc) => columnValue(doc, column)),
      type: PARQUET_TYPES[column.type],
      nullable: column.nullable,
    })),
  });
}
