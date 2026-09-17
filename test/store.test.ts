import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("forget writes the recovery record before rewriting any file (crash-safe)", () => {
  const { base, paths } = tempPaths();
  let daily = "";
  try {
    // Two target files carry the pattern. allMemoryFiles sweeps global first,
    // then the daily log, so a rewrite that fails on the daily file happens
    // AFTER the global file has already been rewritten — a crash mid-loop.
    appendEntry(paths, "global", "obsolete: use webpack");
    appendEntry(paths, "daily", "also tried webpack here");
    daily = join(paths.dailyDir, listDailyFiles(paths)[0]!);

    // Make the daily file un-writable so the rewrite pass throws partway
    // through. (chmod read-only reliably blocks writeFileSync on Windows,
    // macOS and Linux under both node and bun.)
    chmodSync(daily, 0o444);

    let threw = false;
    try {
      forget(paths, "webpack");
    } catch {
      threw = true; // EPERM on the read-only daily file
    }
    assert.ok(threw, "the rewrite of the read-only file must fail, simulating a crash");

    // The invariant: even though a rewrite crashed, the recovery record is on
    // disk, so every removed entry is still undoable. Before the fix the record
    // was written only after all rewrites, so this crash left nothing to undo.
    const records = readdirSync(paths.recoveryDir).filter((f) => f.endsWith(".json"));
    assert.equal(records.length, 1, "a recovery record must exist despite the crashed rewrite");
    const record = JSON.parse(readFileSync(join(paths.recoveryDir, records[0]!), "utf8"));
    assert.equal(record.removals.length, 2, "the record captures every removal, from both files");

    // The global file was already rewritten (the entry is gone) — precisely the
    // state that would be unrecoverable without the record written first.
    assert.ok(!readFileSync(paths.globalMemory, "utf8").toLowerCase().includes("webpack"));

    // And the record genuinely restores: unblock the daily file and undo.
    chmodSync(daily, 0o644);
    const restored = restore(paths, record.id);
    assert.equal(restored, 2);
    assert.ok(readFileSync(paths.globalMemory, "utf8").includes("obsolete: use webpack"));
  } finally {
    if (daily) {
      try {
        chmodSync(daily, 0o644);
      } catch {
        // best-effort: allow cleanup to remove the file
      }
    }
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

test("appendEntry appends rather than rewriting, so it cannot clobber another writer", () => {
  const { base, paths } = tempPaths();
  try {
    appendEntry(paths, "global", "first");
    // Stand in for a second pi process appending directly between our writes.
    appendFileSync(paths.globalMemory, "- from another process\n");
    appendEntry(paths, "global", "second");
    const content = readFileSync(paths.globalMemory, "utf8");
    // Every entry survives — the read-modify-write version could drop the
    // out-of-band line if it had read a stale copy.
    assert.ok(content.includes("- first\n"));
    assert.ok(content.includes("- from another process\n"));
    assert.ok(content.includes("- second\n"));
    // Exactly one header, and it stays at the top.
    assert.equal((content.match(/# Long-term memory/g) ?? []).length, 1);
    assert.ok(content.startsWith("# Long-term memory"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("appendEntry restores the header on an existing-but-empty file", () => {
  const { base, paths } = tempPaths();
  try {
    // A file that exists but holds only whitespace (e.g. an editor left it blank)
    // must get its header back, not a headerless bullet.
    mkdirSync(paths.globalDir, { recursive: true });
    writeFileSync(paths.globalMemory, "\n  \n");
    appendEntry(paths, "global", "revived");
    const content = readFileSync(paths.globalMemory, "utf8");
    assert.ok(content.startsWith("# Long-term memory"));
    assert.ok(content.includes("- revived\n"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

const CONCURRENT_WORKER = fileURLToPath(new URL("./concurrent-append-worker.ts", import.meta.url));

function runWorker(env: NodeJS.ProcessEnv, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONCURRENT_WORKER, ...args], {
      env,
      // stdio piped (not inherited) so a numeric-fd inherit cannot hang the
      // runner on Windows/bun; we do not need the output.
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  });
}

test("two concurrent appendEntry writers keep every entry", async () => {
  const base = mkdtempSync(join(tmpdir(), "pify-memory-conc-"));
  try {
    const cwd = join(base, "project");
    const globalDir = join(base, "global-memory");
    const env = { ...process.env, PI_MEMORY_DIR: globalDir };
    const N = 150;
    // Both processes hammer the same global MEMORY.md at once. The old
    // read-concat-write lost one writer's entries (and could truncate the file
    // to header + one line); the OS-level append keeps all of them.
    await Promise.all([
      runWorker(env, [cwd, "A", String(N)]),
      runWorker(env, [cwd, "B", String(N)]),
    ]);
    const content = readFileSync(join(globalDir, "MEMORY.md"), "utf8");
    const bullets = content.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(bullets.length, 2 * N, "no writer's entries were clobbered");
    assert.equal(bullets.filter((l) => l.includes("A-")).length, N, "all of writer A survived");
    assert.equal(bullets.filter((l) => l.includes("B-")).length, N, "all of writer B survived");
    assert.equal((content.match(/# Long-term memory/g) ?? []).length, 1, "exactly one header");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
