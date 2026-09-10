// Client for the Convex deployment data sync API.
// https://docs.convex.dev/deployment-api/data-sync

export type InclusionDefault = "excl" | "incl";

// "excl" excludes the table entirely; otherwise a per-column selection where
// `_other` is the default for unlisted columns. `_id` cannot be excluded.
export type TableSelection = "excl" | { [columnOrOther: string]: InclusionDefault };

// "excl" excludes the component entirely; otherwise a per-table selection
// where the required `_other` key is the default for unlisted tables.
export type ComponentSelection =
  | "excl"
  | { [tableOrOther: string]: TableSelection | InclusionDefault };

// Keys are component paths (the root component is the empty string), plus a
// required `_other` key as the default for unlisted components.
export type Selection = { [componentPathOrOther: string]: ComponentSelection | InclusionDefault };

export interface DataSyncArgs {
  cursor?: string | null;
  selection?: Selection;
}

export interface DataSyncValue {
  component: string;
  table: string;
  deleted: boolean;
  ts: number;
  // Document fields including _id and _creationTime. Deleted docs only have _id.
  value: Record<string, unknown>;
}

export interface DataSyncTruncate {
  component: string;
  table: string;
}

// The live API (as of 2026-08) reports `snapshotting` while traversing and
// `upToDate` (with `snapshotTs`) once caught up. A newer revision of the
// OpenAPI spec names these `inProgress` and `synced` (with `syncedTs`); both
// vocabularies are accepted since the endpoint is beta.
// `stale` has also been observed from the live API between `snapshotting` and
// `upToDate`: the initial traversal finished but the emitted data is not yet
// consistent (the log replay is still catching up). Not a stop signal.
export type DataSyncStatus =
  | { type: "snapshotting" }
  | { type: "stale" }
  | { type: "upToDate"; snapshotTs: number }
  | { type: "inProgress" }
  | { type: "synced"; syncedTs: number };

// The timestamp at which the synced data is consistent, if caught up.
export function consistentTs(status: DataSyncStatus): number | null {
  if (status.type === "upToDate") {
    return status.snapshotTs;
  }
  if (status.type === "synced") {
    return status.syncedTs;
  }
  return null;
}

// Whether this page means the sync is caught up. `hasMore` alone is not a
// stop signal: the live API returns `hasMore: true` even on `upToDate` pages
// (it is an infinite streaming endpoint), so a one-shot sync must stop on the
// status instead or it will poll forever.
export function isCaughtUp(page: DataSyncResponse): boolean {
  return (
    page.status.type === "upToDate" ||
    page.status.type === "synced" ||
    !page.pagination.hasMore
  );
}

export interface PaginationMetadata {
  hasMore: boolean;
  nextCursor?: string | null;
}

export interface DataSyncResponse {
  pagination: PaginationMetadata;
  status: DataSyncStatus;
  syncId: string;
  truncates: DataSyncTruncate[];
  values: DataSyncValue[];
}

// Loosely typed for the same reason as DataSyncStatus: the live API uses
// `snapshotting`/`upToDate`, the newer spec `inProgress`/`synced`, and the
// fields present depend on the phase.
export interface ActiveDataSyncStatus {
  type: string;
  currentComponent?: string;
  currentTable?: string;
  numDocumentsInCurrentTable?: number;
  numDocumentsSynced?: number;
  numTablesSynced?: number;
  totalDocuments?: number;
  totalDocumentsInCurrentTable?: number;
  totalTables?: number;
  snapshotTs?: number;
  syncedTs?: number;
}

export interface ActiveDataSync {
  lastUpdated: number;
  syncId: string;
  status: ActiveDataSyncStatus;
}

export interface ListActiveSyncsResponse {
  pagination: PaginationMetadata;
  syncs: ActiveDataSync[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  get cursorExpired(): boolean {
    return this.status === 400 && this.code === "DataSyncCursorExpired";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

export class DataSyncClient {
  private readonly deploymentUrl: string;
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(deploymentUrl: string, deployKey: string) {
    this.deploymentUrl = deploymentUrl.replace(/\/+$/, "");
    this.baseUrl = this.deploymentUrl + "/api/v1";
    this.authHeader = `Convex ${deployKey}`;
  }

  // Runs a system UDF (e.g. _system/cli/tables) via the deployment's query
  // endpoint. These power the dashboard/CLI and require the admin key.
  async systemQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetch(this.deploymentUrl + "/api/query", {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    if (!response.ok) {
      throw await toApiError(response);
    }
    const result = (await response.json()) as
      | { status: "success"; value: T }
      | { status: "error"; errorMessage: string };
    if (result.status !== "success") {
      throw new Error(`${path} failed: ${result.errorMessage}`);
    }
    return result.value;
  }

  // Names of the root component's tables (excluding system tables).
  async listRootTables(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | null = null;
    while (true) {
      const page: { page: { name: string }[]; continueCursor: string; isDone: boolean } =
        await this.systemQuery("_system/cli/tables", {
          paginationOpts: { cursor, numItems: 200 },
        });
      names.push(...page.page.map((t) => t.name));
      if (page.isDone) {
        return names.filter((n) => !n.startsWith("_")).sort();
      }
      cursor = page.continueCursor;
    }
  }

  // Number of documents currently in a root-component table.
  async tableSize(tableName: string): Promise<number> {
    return this.systemQuery<number>("_system/frontend/tableSize", { tableName });
  }

  async fetchPage(args: DataSyncArgs, signal?: AbortSignal): Promise<DataSyncResponse> {
    return this.request<DataSyncResponse>("POST", "/data/sync", args, signal);
  }

  // Server-side progress of one sync, or null when the deployment does not
  // know it any more: a sync goes inactive 3 days after its last /data/sync
  // call, and unknown or expired ids answer 404.
  async getActiveSync(syncId: string, signal?: AbortSignal): Promise<ActiveDataSync | null> {
    try {
      return await this.request<ActiveDataSync>(
        "GET",
        `/data/sync/${encodeURIComponent(syncId)}`,
        undefined,
        signal,
      );
    } catch (error) {
      // 404 DataSyncNotFound: unknown id, or one that went inactive.
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // Follows pagination (the endpoint returns pages of syncs, most recently
  // updated first) and returns the combined list.
  async listActiveSyncs(signal?: AbortSignal): Promise<ListActiveSyncsResponse> {
    const syncs: ActiveDataSync[] = [];
    let cursor: string | null = null;
    while (true) {
      const path: string =
        "/data/list_active_syncs" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
      const page = await this.request<ListActiveSyncsResponse>("GET", path, undefined, signal);
      syncs.push(...page.syncs);
      cursor = page.pagination.nextCursor ?? null;
      if (!page.pagination.hasMore || cursor === null) {
        return { syncs, pagination: { hasMore: false } };
      }
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES}): ${lastError?.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      signal?.throwIfAborted();
      let response: Response;
      try {
        response = await fetch(this.baseUrl + path, {
          method,
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
      } catch (error) {
        // Aborts are not transient failures; surface them immediately.
        signal?.throwIfAborted();
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      if (response.ok) {
        return (await response.json()) as T;
      }
      const error = await toApiError(response);
      if (!error.retryable) {
        throw error;
      }
      lastError = error;
    }
    throw lastError ?? new Error("request failed");
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const text = await response.text();
  let code: string | null = null;
  let message = text;
  try {
    const parsed = JSON.parse(text) as { code?: string; message?: string };
    code = parsed.code ?? null;
    message = parsed.message ?? text;
  } catch {
    // Not JSON; keep the raw body as the message.
  }
  return new ApiError(response.status, code, `HTTP ${response.status}: ${message}`);
}
