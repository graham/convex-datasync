import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { loadEnvFiles } from "../src/config.ts";

describe("loadEnvFiles", () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "datasync-env-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const key of ["QE_TEST_DEPLOYMENT", "QE_TEST_QUOTED", "QE_TEST_PLAIN"]) {
      delete process.env[key];
    }
  });

  test("strips inline comments from unquoted values (Convex CLI format)", () => {
    writeFileSync(
      join(dir, ".env.local"),
      "QE_TEST_DEPLOYMENT=dev:happy-otter-123 # team: acme, project: my-app\n",
    );
    loadEnvFiles();
    assert.equal(process.env.QE_TEST_DEPLOYMENT, "dev:happy-otter-123");
  });

  test("keeps # inside quoted values", () => {
    writeFileSync(join(dir, ".env.local"), 'QE_TEST_QUOTED="value # not a comment"\n');
    loadEnvFiles();
    assert.equal(process.env.QE_TEST_QUOTED, "value # not a comment");
  });

  test("real environment wins and .env.local beats .env", () => {
    writeFileSync(join(dir, ".env.local"), "QE_TEST_PLAIN=from-local\n");
    writeFileSync(join(dir, ".env"), "QE_TEST_PLAIN=from-env\nQE_TEST_QUOTED=fallback\n");
    loadEnvFiles();
    assert.equal(process.env.QE_TEST_PLAIN, "from-local");
    assert.equal(process.env.QE_TEST_QUOTED, "fallback");
  });
});
