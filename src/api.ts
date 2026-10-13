// Client for the Convex deployment data sync API.
// https://docs.convex.dev/deployment-api/data-sync
//
// Covers the three documented data endpoints, typed from the public OpenAPI
// spec:
//   POST /data/sync                 stream pages of changes
//   GET  /data/list_active_syncs    progress of every active sync
//   GET  /data/sync/{syncId}        progress of one sync

// The spec's names for the include/exclude flags. The deployment also accepts
// the short forms `incl`/`excl`, but they are not documented.
export type InclusionDefault = "included" | "excluded";

// "excluded" drops the table entirely. Otherwise a per-column selection where
// `_other` is the default for unlisted columns. `_id` cannot be excluded. A bare
// "included" is not valid here: the schema only allows the object form.
export type TableSelection = "excluded" | { _other: InclusionDefault; [column: string]: InclusionDefault };

// "excluded" drops the component entirely. Otherwise a per-table selection
// where `_other` is the default for unlisted tables. Same rule as tables: no
// bare "included".
export type ComponentSelection =
  | "excluded"
  | { _other: InclusionDefault; [table: string]: TableSelection | InclusionDefault };

// Keys are component paths (the root component is the empty string), plus a
// required `_other` as the default for unlisted components.
export type Selection = {
  _other: InclusionDefault;
  [componentPath: string]: ComponentSelection | InclusionDefault;
};

export interface DataSyncArgs {
  cursor?: string | null;
  selection?: Selection;
}

export interface DataSyncValue {
  component: string;
  table: string;
  deleted: boolean;
  // int64 nanoseconds, which a JS number cannot hold exactly. See parseJson.
  ts: bigint;
  // Document fields including _id and _creationTime. Deleted docs only have _id.
  value: Record<string, unknown>;
}

export interface DataSyncTruncate {
  component: string;
  table: string;
}

// `snapshotting`: the traversal of the selected tables is still under way and
//   what has been emitted is an incomplete snapshot.
// `stale`: what has been emitted is a consistent snapshot, but at an older
//   snapshotTs; newer changes are still to come.
// `upToDate`: caught up to the latest consistent snapshot.
export type DataSyncStatus =
  | { type: "snapshotting" }
  | { type: "stale"; snapshotTs: bigint }
  | { type: "upToDate"; snapshotTs: bigint };

// The timestamp at which the synced data is consistent, if the status has one.
export function consistentTs(status: DataSyncStatus): bigint | null {
  return status.type === "snapshotting" ? null : status.snapshotTs;
}

// A one-time sync is finished at the first `upToDate` page. Nothing else
// signals the end: the endpoint is an infinite stream, so `hasMore` is always
// true and `nextCursor` is always present.
export function isCaughtUp(page: DataSyncResponse): boolean {
  return page.status.type === "upToDate";
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

// The deployment's view of a sync, which names the consistent timestamp
// `syncedTs` where the page itself says `snapshotTs`.
export type ActiveDataSyncStatus =
  | {
      type: "snapshotting";
      numTablesSynced: number;
      totalTables: number;
      currentComponent: string;
      currentTable: string;
      numDocumentsInCurrentTable: number;
      totalDocumentsInCurrentTable: number;
      numDocumentsSynced: number;
      totalDocuments: number;
    }
  | { type: "stale"; totalTables: number; numDocumentsSynced: number; syncedTs: bigint }
  | { type: "upToDate"; totalTables: number; numDocumentsSynced: number; syncedTs: bigint };

export interface ActiveDataSync {
  syncId: string;
  // Unix milliseconds of the last /data/sync call this sync made.
  lastUpdated: number;
  status: ActiveDataSyncStatus;
}

export interface ListActiveSyncsResponse {
  pagination: PaginationMetadata;
  syncs: ActiveDataSync[];
}

export interface ListActiveSyncsOptions {
  // 1 to 100; the deployment rejects anything else and defaults to 50.
  limit?: number;
  cursor?: string | null;
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

  // A sync stays active for 3 days after its last page. Past that the cursor
  // is refused. This code is not in the public docs; it is what the deployment
  // is observed to answer.
  get cursorExpired(): boolean {
    return this.status === 400 && this.code === "DataSyncCursorExpired";
  }

  // The cursor could not be parsed at all, e.g. a corrupted cursor file.
  get cursorInvalid(): boolean {
    return this.status === 400 && this.code === "InvalidDataSyncCursor";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

// Fields the spec types as int64 that can exceed 2^53 and so lose digits
// through a plain JSON.parse. Only these are kept exact; document contents are
// left as parsed.
const INT64_KEYS = new Set(["ts", "snapshotTs", "syncedTs"]);

function isInt64Holder(key: string, holder: Record<string, unknown>): boolean {
  // Documents always carry _id and the envelope objects never do, so a holder
  // with _id is user data and is never touched.
  if ("_id" in holder) {
    return false;
  }
  if (key === "ts") {
    return "component" in holder && "table" in holder && "deleted" in holder;
  }
  return typeof holder.type === "string";
}

type ReviverContext = { source?: string } | undefined;

// JSON.parse that keeps the spec's int64 fields exact as bigint. The source
// text of a number is available to the reviver, so no custom parser is needed.
export function parseJson(text: string): unknown {
  const reviver = function (
    this: Record<string, unknown>,
    key: string,
    value: unknown,
    context?: ReviverContext,
  ): unknown {
    const source = context?.source;
    if (
      INT64_KEYS.has(key) &&
      typeof value === "number" &&
      source !== undefined &&
      /^-?\d+$/.test(source) &&
      isInt64Holder(key, this)
    ) {
      return BigInt(source);
    }
    return value;
  };
  return JSON.parse(text, reviver as unknown as Parameters<typeof JSON.parse>[1]);
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

  // NOT part of the documented data sync API. The data sync endpoints take
  // tables by name and have no way to list or count them, so the pattern-based
  // table filters (--include-tables / --exclude-tables) and `dry-run` ask the
  // deployment through the admin system queries the Convex CLI and dashboard
  // use. Everything else in this class is documented; keep these confined to
  // those features so they are all that depends on them.
  private async systemQuery<T>(path: string, args: Record<string, unknown>): Promise<T> {
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

  // Number of documents currently in a root-component table. Also an
  // undocumented admin query (the one behind the dashboard's table counts),
  // used only by `dry-run`.
  async tableSize(tableName: string): Promise<number> {
    return this.systemQuery<number>("_system/frontend/tableSize", { tableName });
  }

  // Names of the root component's tables (excluding system tables). See
  // systemQuery: undocumented, used only by the regex table filters and
  // `dry-run`.
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

  // Omits the cursor on the first call and the selection when nothing is
  // restricted, as the docs describe, rather than sending explicit nulls.
  async fetchPage(args: DataSyncArgs, signal?: AbortSignal): Promise<DataSyncResponse> {
    const body: DataSyncArgs = {};
    if (args.cursor) {
      body.cursor = args.cursor;
    }
    if (args.selection !== undefined) {
      body.selection = args.selection;
    }
    return this.request<DataSyncResponse>("POST", "/data/sync", body, signal);
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
      if (error instanceof ApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  // One page of active syncs, most recently updated first.
  async listActiveSyncsPage(
    options: ListActiveSyncsOptions = {},
    signal?: AbortSignal,
  ): Promise<ListActiveSyncsResponse> {
    const query = new URLSearchParams();
    if (options.limit !== undefined) {
      query.set("limit", String(options.limit));
    }
    if (options.cursor) {
      query.set("cursor", options.cursor);
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.request<ListActiveSyncsResponse>(
      "GET",
      `/data/list_active_syncs${suffix}`,
      undefined,
      signal,
    );
  }

  // Follows pagination to the end and returns every active sync.
  async listActiveSyncs(signal?: AbortSignal): Promise<ListActiveSyncsResponse> {
    const syncs: ActiveDataSync[] = [];
    let cursor: string | null = null;
    while (true) {
      const page: ListActiveSyncsResponse = await this.listActiveSyncsPage({ cursor }, signal);
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
        return parseJson(await response.text()) as T;
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
