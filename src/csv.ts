// RFC 4180 CSV with a header row and LF line endings.
//
// Following Postgres' COPY ... CSV convention, a null (or a key the document
// does not have) is written as a bare empty field while an empty string is
// written as `""`, so the two stay distinguishable.

import { columnValue, deriveColumns, type Column } from "./tabular.ts";

function escapeField(field: string): string {
  if (field === "" || /["\r\n,]/.test(field)) {
    return `"${field.replaceAll('"', '""')}"`;
  }
  return field;
}

function renderField(value: unknown, column: Column): string {
  if (value === null) {
    return "";
  }
  return escapeField(column.type === "json" ? JSON.stringify(value) : String(value));
}

export function toCsv(docs: Iterable<Record<string, unknown>>): string {
  const rows = [...docs];
  const columns = deriveColumns(rows);
  if (columns.length === 0) {
    return "";
  }
  let out = columns.map((column) => escapeField(column.name)).join(",") + "\n";
  for (const doc of rows) {
    out += columns.map((column) => renderField(columnValue(doc, column), column)).join(",") + "\n";
  }
  return out;
}
