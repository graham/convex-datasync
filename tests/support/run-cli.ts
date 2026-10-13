// Runs the real CLI as a subprocess, the way a user would, against a
// FakeDeployment. Each run gets the caller's working directory, an empty HOME
// (so no real `convex login` session is ever consulted) and credentials in the
// environment.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeDeployment } from "./fake-deployment.ts";

export const CLI = join(import.meta.dirname, "..", "..", "src", "cli.ts");

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  // stdout and stderr together, for assertions that do not care which.
  output: string;
}

export function tempDir(prefix = "datasync-cli-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Overrides layered over the default environment; undefined removes a variable.
export type EnvOverrides = Record<string, string | undefined>;

export function cliEnv(
  fake: FakeDeployment,
  cwd: string,
  overrides: EnvOverrides = {},
): NodeJS.ProcessEnv {
  const home = join(cwd, ".home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CONVEX_URL: fake.url,
    CONVEX_DEPLOY_KEY: fake.deployKey,
    NO_COLOR: "1",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

export interface CliOptions {
  env?: EnvOverrides;
  timeoutMs?: number;
}

export class RunningCli {
  readonly child: ChildProcess;
  private out = "";
  private err = "";
  private waiters: { pattern: RegExp; resolve: () => void }[] = [];
  readonly exited: Promise<number | null>;

  constructor(fake: FakeDeployment, args: string[], cwd: string, options: CliOptions = {}) {
    this.child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: cliEnv(fake, cwd, options.env),
    });
    this.child.stdout!.on("data", (d: Buffer) => this.take("out", d));
    this.child.stderr!.on("data", (d: Buffer) => this.take("err", d));
    this.exited = new Promise((resolve) => this.child.on("close", (code) => resolve(code)));
  }

  private take(stream: "out" | "err", data: Buffer): void {
    if (stream === "out") this.out += data.toString();
    else this.err += data.toString();
    this.waiters = this.waiters.filter((w) => {
      if (w.pattern.test(this.out + this.err)) {
        w.resolve();
        return false;
      }
      return true;
    });
  }

  get stdout(): string {
    return this.out;
  }

  get stderr(): string {
    return this.err;
  }

  // Resolves once the output matches, or rejects with what was seen instead.
  waitFor(pattern: RegExp, timeoutMs = 15_000): Promise<void> {
    if (pattern.test(this.out + this.err)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        reject(new Error(`timed out waiting for ${pattern}; output so far:\n${this.out}${this.err}`));
      }, timeoutMs);
      this.waiters.push({
        pattern,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  signal(sig: NodeJS.Signals): void {
    this.child.kill(sig);
  }

  async result(): Promise<CliResult> {
    const code = await this.exited;
    return { code, stdout: this.out, stderr: this.err, output: this.out + this.err };
  }
}

// Runs to completion. A command that should exit by itself but does not is
// killed and reported rather than left hanging the suite.
export async function runCli(
  fake: FakeDeployment,
  args: string[],
  cwd: string,
  options: CliOptions = {},
): Promise<CliResult> {
  const running = new RunningCli(fake, args, cwd, options);
  const timer = setTimeout(() => running.child.kill("SIGKILL"), options.timeoutMs ?? 30_000);
  try {
    return await running.result();
  } finally {
    clearTimeout(timer);
  }
}

export function startCli(
  fake: FakeDeployment,
  args: string[],
  cwd: string,
  options: CliOptions = {},
): RunningCli {
  return new RunningCli(fake, args, cwd, options);
}
