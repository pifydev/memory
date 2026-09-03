import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths, localDateStr } from "../src/paths.ts";
import {
  allMemoryFiles,
  appendEntry,
  forget,
  listDailyFiles,
  readFileSafe,
  restore,
} from "../src/store.ts";

function tempPaths() {
  const base = mkdtempSync(join(tmpdir(), "pify-memory-"));
  const cwd = join(base, "project");
  const paths = resolvePaths(cwd, { PI_MEMORY_DIR: join(base, "global-memory") });
  return { base, paths };
}

test("appendEntry creates files with headers and appends bullets", () => {
  const { base, paths } = tempPaths();
  try {
    appendEntry(paths, "global", "prefers pnpm");
    appendEntry(paths, "global", "hates yaml");
    const content = readFileSync(paths.globalMemory, "utf8");
    assert.ok(content.startsWith("# Long-term memory"));
    assert.ok(content.includes("- prefers pnpm\n"));
    assert.ok(content.endsWith("- hates yaml\n"));

    appendEntry(paths, "project", "monorepo uses turbo");
    assert.ok(readFileSync(paths.projectMemory, "utf8").includes("- monorepo uses turbo"));

    appendEntry(paths, "daily", "shipped the release");
    const daily = listDailyFiles(paths);
    assert.deepEqual(daily, [`${localDateStr()}.md`]);
    const dailyContent = readFileSync(join(paths.dailyDir, daily[0]!), "utf8");
    assert.match(dailyContent, /- \d{2}:\d{2} shipped the release/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("allMemoryFiles lists only existing files", () => {
  const { base, paths } = tempPaths();
  try {
    assert.deepEqual(allMemoryFiles(paths), []);
    appendEntry(paths, "global", "a");
    appendEntry(paths, "daily", "b");
    const files = allMemoryFiles(paths);
    assert.equal(files.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("forget removes matching bullets, writes recovery; restore undoes", () => {
  const { base, paths } = tempPaths();
  try {
    appendEntry(paths, "global", "keep this fact");
    appendEntry(paths, "global", "obsolete: use webpack");
    appendEntry(paths, "daily", "tried Webpack config");

    const result = forget(paths, "webpack");
    assert.equal(result.removed, 2);
    assert.ok(result.recoveryId);
    const remaining = readFileSync(paths.globalMemory, "utf8");
    assert.ok(remaining.includes("keep this fact"));
    assert.ok(!remaining.toLowerCase().includes("webpack"));
    // headers survive the sweep
    assert.ok(remaining.startsWith("# Long-term memory"));

    const restored = restore(paths, result.recoveryId!);
    assert.equal(restored, 2);
    assert.ok(readFileSync(paths.globalMemory, "utf8").includes("obsolete: use webpack"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("forget with no matches writes no recovery", () => {
  const { base, paths } = tempPaths();
  try {
    appendEntry(paths, "global", "something");
    const result = forget(paths, "nonexistent-pattern");
    assert.equal(result.removed, 0);
    assert.equal(result.recoveryId, null);
    assert.equal(forget(paths, "   ").removed, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("readFileSafe returns null for missing files", () => {
  assert.equal(readFileSafe(join(tmpdir(), "definitely-missing-xyz.md")), null);
});
