// Regex-based table filtering (--include-tables / --exclude-tables) and the
// selection objects it produces for the data sync API.

import type { Selection, TableSelection } from "./api.ts";

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

// Builds a sync selection from the filter, given the deployment's root-table
// names. The filter applies to root-component tables; other components stay
// fully included in exclude-mode and are excluded in include-mode.
export function selectionFromFilter(rootTables: string[], filter: TableFilter): Selection {
  const root: Record<string, TableSelection> = {};
  if (filter.include) {
    for (const table of rootTables) {
      if (tableMatches(table, filter)) {
        root[table] = { _other: "incl" };
      }
    }
    return { _other: "excl", "": { _other: "excl", ...root } };
  }
  for (const table of rootTables) {
    if (!tableMatches(table, filter)) {
      root[table] = "excl";
    }
  }
  return { _other: "incl", "": { _other: "incl", ...root } };
}
