// Regex-based table filtering (--include-tables / --exclude-tables) and the
// selection objects it produces for the data sync API.

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

// Columns named bare apply to every table; `table:column` scopes one table.
export interface ColumnFilter {
  mode: "include" | "exclude";
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
  return {
    include:
      includeSpec === undefined
        ? undefined
        : new Set(parseNames(includeSpec, "--components")),
    exclude:
      excludeSpec === undefined
        ? undefined
        : new Set(parseNames(excludeSpec, "--exclude-components")),
  };
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
    // The API always returns _id; a selection that dropped it would leave
    // documents the store cannot key.
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
  return { mode, all, byTable };
}

// Columns wanted for one root table, or null when the filter says nothing
// about it and the whole document should come through.
function columnsFor(table: string, filter: ColumnFilter | null): Set<string> | null {
  if (filter === null) {
    return null;
  }
  const columns = new Set([...filter.all, ...(filter.byTable.get(table) ?? [])]);
  return columns.size === 0 ? null : columns;
}

function tableSelection(table: string, columns: ColumnFilter | null): TableSelection {
  const wanted = columnsFor(table, columns);
  if (wanted === null || columns === null) {
    return { _other: "incl" };
  }
  const selection: Record<string, InclusionDefault> = {};
  if (columns.mode === "include") {
    selection._other = "excl";
    selection._id = "incl";
    for (const column of wanted) {
      selection[column] = "incl";
    }
  } else {
    selection._other = "incl";
    for (const column of wanted) {
      selection[column] = "excl";
    }
  }
  return selection;
}

export interface SelectionInput {
  // The deployment's root-component table names. Required whenever a regex
  // table filter or a column filter is in play, since both need every table
  // named explicitly in the selection.
  rootTables?: string[] | null;
  // Exact --tables list.
  tables?: string[] | null;
  tableFilter?: TableFilter | null;
  components?: ComponentFilter | null;
  columns?: ColumnFilter | null;
}

// True when building the selection needs the deployment's table list: a regex
// filter has to be resolved against real names, and a column filter has to
// name every table it applies to - unless an exact --tables list already does.
export function needsRootTables(input: SelectionInput): boolean {
  if ((input.tableFilter ?? null) !== null) {
    return true;
  }
  const hasExactTables = (input.tables ?? null) !== null && (input.tables as string[]).length > 0;
  return (input.columns ?? null) !== null && !hasExactTables;
}

// Builds the sync selection. Table and column filters apply to root-component
// tables; component filters select whole components. Returns undefined when
// nothing is restricted, so the sync can omit the selection entirely.
export function buildSelection(input: SelectionInput): Selection | undefined {
  const { tables = null, tableFilter = null, components = null, columns = null } = input;
  const rootTables = input.rootTables ?? null;
  if (needsRootTables(input) && rootTables === null) {
    throw new Error("building this selection needs the deployment's root table list");
  }

  let root: ComponentSelection | undefined;
  if (tables !== null && tables.length > 0) {
    root = { _other: "excl" };
    for (const table of tables) {
      root[table] = tableSelection(table, columns);
    }
  } else if (tableFilter?.include) {
    root = { _other: "excl" };
    for (const table of rootTables as string[]) {
      if (tableMatches(table, tableFilter)) {
        root[table] = tableSelection(table, columns);
      }
    }
  } else if (tableFilter !== null || columns !== null) {
    // Everything stays in, but each surviving table still has to be named for
    // its column selection to attach.
    root = { _other: "incl" };
    for (const table of rootTables as string[]) {
      if (tableFilter !== null && !tableMatches(table, tableFilter)) {
        root[table] = "excl";
      } else if (columnsFor(table, columns) !== null) {
        root[table] = tableSelection(table, columns);
      }
    }
  }

  const restrictsToList =
    (tables !== null && tables.length > 0) ||
    tableFilter?.include !== undefined ||
    components?.include !== undefined;
  const selection: Selection = { _other: restrictsToList ? "excl" : "incl" };

  for (const name of components?.include ?? []) {
    selection[componentPath(name)] = "incl";
  }
  if (root !== undefined) {
    selection[""] = root;
  }
  for (const name of components?.exclude ?? []) {
    selection[componentPath(name)] = "excl";
  }

  return Object.keys(selection).length === 1 && selection._other === "incl"
    ? undefined
    : selection;
}
