// Column derivation shared by the tabular export formats (csv, parquet).
//
// Convex documents are schemaless, so a table has no declared column set: it is
// the union of every top-level key seen in the table, with _id and _creationTime
// first (the fields every document carries) and the rest alphabetically. A key
// missing from some document is treated the same as a null in it.
//
// Column types are inferred the same way. A column holding one JSON scalar type
// keeps it; anything else - nested objects, arrays, or a key whose type varies
// between documents - becomes JSON text, which both formats can represent.

export type ColumnType = "boolean" | "number" | "string" | "json";

export interface Column {
  name: string;
  type: ColumnType;
  // True when at least one document omits the key or holds null there.
  nullable: boolean;
}

const LEADING_COLUMNS = ["_id", "_creationTime"];

function kindOf(value: unknown): ColumnType {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    default:
      return "json";
  }
}

export function deriveColumns(docs: Iterable<Record<string, unknown>>): Column[] {
  const kinds = new Map<string, Set<ColumnType>>();
  const present = new Map<string, number>();
  const nullable = new Set<string>();
  let documents = 0;

  for (const doc of docs) {
    documents++;
    for (const [key, value] of Object.entries(doc)) {
      let kind = kinds.get(key);
      if (kind === undefined) {
        kind = new Set();
        kinds.set(key, kind);
      }
      present.set(key, (present.get(key) ?? 0) + 1);
      if (value === null || value === undefined) {
        nullable.add(key);
      } else {
        kind.add(kindOf(value));
      }
    }
  }

  const leading = LEADING_COLUMNS.filter((name) => kinds.has(name));
  const rest = [...kinds.keys()].filter((name) => !leading.includes(name)).sort();
  return [...leading, ...rest].map((name) => {
    const kind = kinds.get(name) ?? new Set<ColumnType>();
    // An all-null column has no observed type; string holds nothing but nulls.
    const [only] = kind;
    return {
      name,
      type: kind.size === 1 && only !== undefined ? only : kind.size === 0 ? "string" : "json",
      nullable: nullable.has(name) || (present.get(name) ?? 0) < documents,
    };
  });
}

// The value to write for a column, with missing keys normalized to null. Values
// of a json column are returned as-is; each format serializes them itself.
export function columnValue(doc: Record<string, unknown>, column: Column): unknown {
  const value = doc[column.name];
  return value === undefined ? null : value;
}
