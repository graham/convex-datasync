// Builds the `selection` argument of /data/sync from command-line flags.
//
// The selection reaches three levels: components, the tables in them, and the
// columns of those tables. Table and column flags address root-component
// tables; component flags address whole components.
//
// Everything built here has to match the schema in the public docs, which is
// stricter than it looks: a component or table that is included is written as
// an object ({ _other: "included" }), never as the bare string "included",
// which the deployment rejects. Only "excluded" may stand alone.

import type {
  ComponentSelection,
  InclusionDefault,
  Selection,
  TableSelection,
} from "./api.ts";

export interface TableFilter {
  include?: RegExp;
  exclude?: RegExp;
}

export function parseTableFilter(
  includePattern?: string,
  excludePattern?: string,
): TableFilter | null {
  if (includePattern === undefined && excludePattern === undefined) {
    return null;
  }
  const compile = (pattern: string, flag: string): RegExp => {
    try {
      return new RegExp(pattern);
    } catch (error) {
      throw new Error(
        `invalid ${flag} regex "${pattern}": ${error instanceof Error ? error.message : error}`,
      );
    }
  };
  return {
    include: includePattern !== undefined ? compile(includePattern, "--include-tables") : undefined,
    exclude: excludePattern !== undefined ? compile(excludePattern, "--exclude-tables") : undefined,
  };
}

export function tableMatches(table: string, filter: TableFilter): boolean {
  if (filter.include && !filter.include.test(table)) {
    return false;
  }
  if (filter.exclude && filter.exclude.test(table)) {
    return false;
  }
  return true;
}

// The root component's path is the empty string in the API; on the command
// line it needs a name.
export const ROOT_COMPONENT_ALIAS = "_root";

function componentPath(name: string): string {
  return name === ROOT_COMPONENT_ALIAS ? "" : name;
}

export interface ComponentFilter {
  include?: Set<string>;
  exclude?: Set<string>;
}

// Columns named bare apply to every table named by --tables; `table:column`
// scopes one table.
export interface ColumnFilter {
  mode: "include" | "exclude";
  flag: string;
  all: Set<string>;
  byTable: Map<string, Set<string>>;
}

function parseNames(spec: string, flag: string): string[] {
  const names = spec
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) {
    throw new Error(`${flag} is empty`);
  }
  return names;
}

export function parseComponentFilter(
  includeSpec?: string,
  excludeSpec?: string,
): ComponentFilter | null {
  if (includeSpec === undefined && excludeSpec === undefined) {
    return null;
  }
  const include =
    includeSpec === undefined ? undefined : new Set(parseNames(includeSpec, "--components"));
  const exclude =
    excludeSpec === undefined
      ? undefined
      : new Set(parseNames(excludeSpec, "--exclude-components"));
  for (const name of include ?? []) {
    if (exclude?.has(name)) {
      throw new Error(`component "${name}" is in both --components and --exclude-components`);
    }
  }
  return { include, exclude };
}

export function parseColumnFilter(
  includeSpec?: string,
  excludeSpec?: string,
): ColumnFilter | null {
  if (includeSpec === undefined && excludeSpec === undefined) {
    return null;
  }
  if (includeSpec !== undefined && excludeSpec !== undefined) {
    throw new Error("--include-columns cannot be combined with --exclude-columns");
  }
  const mode = includeSpec !== undefined ? "include" : "exclude";
  const flag = mode === "include" ? "--include-columns" : "--exclude-columns";
  const all = new Set<string>();
  const byTable = new Map<string, Set<string>>();
  for (const entry of parseNames((includeSpec ?? excludeSpec) as string, flag)) {
    const split = entry.indexOf(":");
    const table = split === -1 ? null : entry.slice(0, split).trim();
    const column = (split === -1 ? entry : entry.slice(split + 1)).trim();
    if (column.length === 0 || (table !== null && table.length === 0)) {
      throw new Error(`${flag}: "${entry}" is not a column or table:column`);
    }
    // The deployment does not allow _id to be excluded, and the store keys
    // documents by it.
    if (mode === "exclude" && column === "_id") {
      throw new Error(`${flag}: _id cannot be excluded`);
    }
    if (table === null) {
      all.add(column);
    } else {
      let columns = byTable.get(table);
      if (!columns) {
        columns = new Set();
        byTable.set(table, columns);
      }
      columns.add(column);
    }
  }
  return { mode, flag, all, byTable };
}

function tableSelection(table: string, columns: ColumnFilter | null): TableSelection {
  const wanted = new Set([...(columns?.all ?? []), ...(columns?.byTable.get(table) ?? [])]);
  if (columns === null || wanted.size === 0) {
    return { _other: "included" };
  }
  const selection: { _other: InclusionDefault; [column: string]: InclusionDefault } =
    columns.mode === "include"
      ? // _id is always kept, but naming it makes the selection say so.
        { _other: "excluded", _id: "included" }
      : { _other: "included" };
  for (const column of wanted) {
    selection[column] = columns.mode === "include" ? "included" : "excluded";
  }
  return selection;
}

export interface SelectionInput {
  // Exact list of root-component tables to sync.
  tables?: string[] | null;
  // Regex filters over the deployment's root tables; need rootTables.
  tableFilter?: TableFilter | null;
  // The deployment's root-component table names, which the data sync API
  // cannot supply. Required when tableFilter is set and unused otherwise.
  rootTables?: string[] | null;
  components?: ComponentFilter | null;
  columns?: ColumnFilter | null;
}

// True when the selection cannot be built without the deployment's tables.
export function needsRootTables(input: SelectionInput): boolean {
  return (input.tableFilter ?? null) !== null;
}

// Returns undefined when nothing is restricted, so the sync can omit the
// selection entirely.
export function buildSelection(input: SelectionInput): Selection | undefined {
  const exact = input.tables && input.tables.length > 0 ? input.tables : null;
  const tableFilter = input.tableFilter ?? null;
  const components = input.components ?? null;
  const columns = input.columns ?? null;

  if (exact !== null && tableFilter !== null) {
    throw new Error("--tables cannot be combined with --include-tables/--exclude-tables");
  }
  if (tableFilter !== null && input.rootTables == null) {
    throw new Error("building this selection needs the deployment's root table list");
  }

  // The tables a table-level restriction names. A regex include resolves to
  // the matching tables, so from here on it behaves exactly like --tables.
  const tables =
    exact ??
    (tableFilter?.include
      ? (input.rootTables as string[]).filter((t) => tableMatches(t, tableFilter))
      : null);
  // An exclude-only filter leaves every other table in, so it is the one case
  // where the named tables are the ones being removed.
  const excludedTables =
    tableFilter !== null && !tableFilter.include
      ? (input.rootTables as string[]).filter((t) => !tableMatches(t, tableFilter))
      : [];
  // Tables a bare column name can reach: those named, or all that remain.
  const reachable =
    tables ??
    (tableFilter !== null
      ? (input.rootTables as string[]).filter((t) => !excludedTables.includes(t))
      : null);

  if (columns !== null) {
    if (columns.all.size > 0 && reachable === null) {
      // The schema can only attach a column selection to a table that is
      // named, and without --tables or a table filter nothing names them.
      throw new Error(
        `${columns.flag}: a bare column name applies to the tables named by --tables ` +
          "or matched by --include-tables/--exclude-tables; use table:column, or add one of those",
      );
    }
    for (const table of columns.byTable.keys()) {
      if (reachable !== null && !reachable.includes(table)) {
        throw new Error(
          `${columns.flag}: table "${table}" is not selected by --tables/--include-tables/--exclude-tables`,
        );
      }
    }
  }

  const rootExcluded = components?.exclude?.has(ROOT_COMPONENT_ALIAS) ?? false;
  const needsRoot =
    tables !== null || tableFilter !== null || (columns?.byTable.size ?? 0) > 0;
  if (rootExcluded && needsRoot) {
    throw new Error(
      "--exclude-components _root conflicts with --tables / --include-columns / --exclude-columns, " +
        "which select root-component tables",
    );
  }

  let root: ComponentSelection | undefined;
  if (tables !== null) {
    const selected: Record<string, TableSelection | InclusionDefault> = { _other: "excluded" };
    for (const table of tables) {
      selected[table] = tableSelection(table, columns);
    }
    root = selected as ComponentSelection;
  } else if (tableFilter !== null) {
    // Exclude-only filter: everything stays in except the matches, and a
    // surviving table is named only when it has a column selection to carry.
    const selected: Record<string, TableSelection | InclusionDefault> = { _other: "included" };
    for (const table of excludedTables) {
      selected[table] = "excluded";
    }
    for (const table of reachable ?? []) {
      const selection = tableSelection(table, columns);
      if (typeof selection === "object" && Object.keys(selection).length > 1) {
        selected[table] = selection;
      }
    }
    root = selected as ComponentSelection;
  } else if (columns !== null && columns.byTable.size > 0) {
    // Every other root table stays whole; only the named ones get a column
    // selection, which is all that attaching one requires.
    const selected: Record<string, TableSelection | InclusionDefault> = { _other: "included" };
    for (const table of columns.byTable.keys()) {
      selected[table] = tableSelection(table, columns);
    }
    root = selected as ComponentSelection;
  }

  const restricted = tables !== null || components?.include !== undefined;
  const selection: Selection = { _other: restricted ? "excluded" : "included" };

  for (const name of components?.include ?? []) {
    selection[componentPath(name)] = { _other: "included" };
  }
  if (root !== undefined) {
    selection[""] = root;
  }
  for (const name of components?.exclude ?? []) {
    selection[componentPath(name)] = "excluded";
  }

  return Object.keys(selection).length === 1 && selection._other === "included"
    ? undefined
    : selection;
}
