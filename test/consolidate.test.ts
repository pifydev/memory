import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_REMOVAL_RATIO,
  assessConsolidation,
  buildConsolidatePrompt,
  bulletsOf,
  consolidationPreview,
  parseConsolidation,
} from "../src/consolidate.ts";
import { resolvePaths } from "../src/paths.ts";
import { restore, snapshotFile } from "../src/store.ts";

const BEFORE = [
  "# Long-term memory",
  "",
  "- User prefers Vietnamese for conversation",
  "- User prefers tabs for indentation",
  "- The user prefers spaces for indentation, not tabs",
  "- Deploy target is Vercel",
  "- Deploy target is Vercel (project pify-web)",
  "- Test runner is bun",
].join("\n");

test("buildConsolidatePrompt fences the file content", () => {
  const prompt = buildConsolidatePrompt("global", BEFORE);
  assert.ok(prompt.includes("```markdown"));
  assert.ok(prompt.includes("Deploy target is Vercel"));
  assert.ok(prompt.includes("(global)"));
});

test("parseConsolidation pulls markdown out of any wrapper", () => {
  assert.equal(parseConsolidation("```markdown\n# X\n- a\n```"), "# X\n- a");
  assert.equal(parseConsolidation("```md\n- a\n```"), "- a");
  assert.equal(parseConsolidation("```\n- a\n```"), "- a");
  // unfenced, but still shaped like the file
  assert.equal(parseConsolidation("# X\n- a"), "# X\n- a");
  // unfenced prose is not a memory file
  assert.equal(parseConsolidation("Sure! Here is what I would do."), null);
  assert.equal(parseConsolidation(""), null);
  assert.equal(parseConsolidation("   "), null);
});

test("bulletsOf counts entries, not structure", () => {
  assert.equal(bulletsOf(BEFORE).length, 6);
  assert.equal(bulletsOf("# heading\n\nsome prose").length, 0);
  assert.equal(bulletsOf("* star bullets count").length, 1);
});

test("assessConsolidation accepts a real consolidation", () => {
  const after = [
    "# Long-term memory",
    "",
    "- User prefers Vietnamese for conversation",
    "- The user prefers spaces for indentation, not tabs",
    "- Deploy target is Vercel (project pify-web)",
    "- Test runner is bun",
  ].join("\n");
  const result = assessConsolidation(BEFORE, after);
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.keptCount, 4);
  assert.equal(result.removedCount, 2);
  assert.deepEqual(result.invented, []);
});

test("assessConsolidation refuses invention", () => {
  const after = [
    "# Long-term memory",
    "",
    "- User prefers Vietnamese for conversation",
    "- The user prefers spaces for indentation, not tabs",
    "- Deploy target is Vercel (project pify-web)",
    "- Production database is Postgres on Neon",
  ].join("\n");
  const result = assessConsolidation(BEFORE, after);
  assert.equal(result.ok, false);
  assert.ok(result.reason!.includes("appear nowhere"));
  assert.equal(result.invented.length, 1);
  assert.ok(result.invented[0]!.includes("Postgres"));
});

test("assessConsolidation refuses an emptied or gutted file", () => {
  const empty = assessConsolidation(BEFORE, "# Long-term memory\n");
  assert.equal(empty.ok, false);
  assert.ok(empty.reason!.includes("no entries"));

  const gutted = assessConsolidation(BEFORE, "# Long-term memory\n\n- Test runner is bun");
  assert.equal(gutted.ok, false);
  assert.ok(gutted.reason!.includes("drops"));
  assert.ok(5 / 6 > MAX_REMOVAL_RATIO);
});

test("assessConsolidation tolerates merged wording and time prefixes", () => {
  const daily = ["# Daily log 2026-09-06", "", "- 09:15 fixed the parser", "- 10:02 fixed the parser again"].join("\n");
  const merged = ["# Daily log 2026-09-06", "", "- 10:02 fixed the parser again"].join("\n");
  assert.equal(assessConsolidation(daily, merged).ok, true);
});

test("consolidationPreview shows the size change and what was folded in", () => {
  const after = [
    "# Long-term memory",
    "",
    "- User prefers Vietnamese for conversation",
    "- The user prefers spaces for indentation, not tabs",
    "- Deploy target is Vercel (project pify-web)",
    "- Test runner is bun",
  ].join("\n");
  const preview = consolidationPreview(BEFORE, after);
  assert.ok(preview.includes("6 entries → 4"));
  assert.ok(preview.includes("chars"));
  assert.ok(preview.includes("tabs for indentation"));
});

test("snapshotFile + restore round-trips a consolidated file", () => {
  const base = mkdtempSync(join(tmpdir(), "pify-memcons-"));
  try {
    const paths = resolvePaths(base, { PI_MEMORY_DIR: join(base, "mem") });
    const file = paths.globalMemory;
    mkdirSync(paths.globalDir, { recursive: true });
    writeFileSync(file, BEFORE);

    const id = snapshotFile(paths, file, BEFORE);
    writeFileSync(file, "# Long-term memory\n\n- consolidated\n");
    assert.ok(!readFileSync(file, "utf8").includes("Deploy target"));

    const restored = restore(paths, id);
    assert.equal(restored, 1);
    assert.equal(readFileSync(file, "utf8"), BEFORE);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
