// Shared setup for the CLI tests: a fresh FakeDeployment and working
// directory per test, and helpers to read back what the CLI wrote.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { collect } from "../../src/datastore.ts";
import { DeltaLogStore } from "../../src/deltalog.ts";
import { Store } from "../../src/store.ts";
import { FakeDeployment } from "./fake-deployment.ts";
import { runCli, startCli, tempDir, type CliOptions, type CliResult, type RunningCli } from "./run-cli.ts";

export interface Context {
  fake: FakeDeployment;
  dir: string;
  run(args: string[], options?: CliOptions): Promise<CliResult>;
  start(args: string[], options?: CliOptions): RunningCli;
  path(...parts: string[]): string;
}

export function useDeployment(seed = true): Context {
  const ctx = {} as Context;
  beforeEach(async () => {
    ctx.fake = new FakeDeployment();
    if (seed) ctx.fake.seed();
    await ctx.fake.start();
    ctx.dir = tempDir();
    ctx.run = (args, options) => runCli(ctx.fake, args, ctx.dir, options);
    ctx.start = (args, options) => startCli(ctx.fake, args, ctx.dir, options);
    ctx.path = (...parts) => join(ctx.dir, ...parts);
  });
  afterEach(async () => {
    await ctx.fake.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  });
  return ctx;
}

// What a sqlite copy holds for a table, in _id order.
export async function sqliteDocs(db: string, table: string, component = "", includeDeleted = false) {
  const store = new Store(db);
  try {
    return await collect(store.readTable(component, table, includeDeleted));
  } finally {
    store.close();
  }
}

export async function sqliteTables(db: string): Promise<string[]> {
  const store = new Store(db);
  try {
    return (await store.tableStats()).map((s) => `${s.component ? s.component + "/" : ""}${s.table}`);
  } finally {
    store.close();
  }
}

export async function logDocs(dir: string, table: string, component = "") {
  const store = new DeltaLogStore(dir);
  try {
    return await collect(store.readTable(component, table));
  } finally {
    store.close();
  }
}

export const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((d) => d._id);
