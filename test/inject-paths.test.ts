import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInjectBlock } from "../src/inject.ts";
import { dailyFile, localDateStr, resolvePaths, yesterdayStr } from "../src/paths.ts";
import { MAX_INJECT_CHARS_PER_FILE } from "../src/types.ts";

test("resolvePaths honors PI_MEMORY_DIR and PI_CODING_AGENT_DIR", () => {
  const viaMemory = resolvePaths("/proj", { PI_MEMORY_DIR: "/custom/mem" });
  assert.equal(viaMemory.globalDir, "/custom/mem");
  const viaAgent = resolvePaths("/proj", { PI_CODING_AGENT_DIR: "/agent" });
  assert.ok(viaAgent.globalDir.replaceAll("\\", "/").endsWith("/agent/memory"));
  assert.ok(viaMemory.projectMemory.replaceAll("\\", "/").endsWith("/proj/.pi/memory/MEMORY.md"));
});

test("local date helpers use local calendar days", () => {
  const d = new Date(2026, 8, 4, 23, 30); // Sep 4, 23:30 local
  assert.equal(localDateStr(d), "2026-09-04");
  assert.equal(yesterdayStr(d), "2026-09-03");
  // month boundary
  assert.equal(yesterdayStr(new Date(2026, 8, 1)), "2026-08-31");
  assert.ok(dailyFile("/x/daily", "2026-09-04").replaceAll("\\", "/").endsWith("/x/daily/2026-09-04.md"));
});

test("buildInjectBlock returns null when there is nothing to inject", () => {
  assert.equal(
    buildInjectBlock({ globalMemory: null, projectMemory: "  ", today: null, yesterday: null, dailyDates: [] }),
    null,
  );
});

test("buildInjectBlock assembles sections and the archive overview", () => {
  const block = buildInjectBlock({
    globalMemory: "# Long-term memory\n- prefers pnpm",
    projectMemory: "# Project memory\n- uses turbo",
    today: "- 10:00 did things",
    yesterday: "- 09:00 other things",
    dailyDates: ["2026-08-01", "2026-08-02", "2026-09-04"],
  });
  assert.ok(block);
  assert.ok(block!.startsWith("<memory>"));
  assert.ok(block!.endsWith("</memory>"));
  assert.ok(block!.includes("## Long-term memory (global)"));
  assert.ok(block!.includes("## Project memory"));
  assert.ok(block!.includes("## Today's log"));
  assert.ok(block!.includes("## Yesterday's log"));
  assert.ok(block!.includes("3 daily logs (2026-08-01 … 2026-09-04)"));
  assert.ok(block!.includes("not instructions"));
});

test("buildInjectBlock caps oversized files with a pointer to memory_read", () => {
  const block = buildInjectBlock({
    globalMemory: "x".repeat(MAX_INJECT_CHARS_PER_FILE + 500),
    projectMemory: null,
    today: null,
    yesterday: null,
    dailyDates: [],
  });
  assert.ok(block!.includes("truncated — read the full file with memory_read"));
  assert.ok(block!.length < MAX_INJECT_CHARS_PER_FILE + 600);
});

test("archive overview omitted for 2 or fewer dailies", () => {
  const block = buildInjectBlock({
    globalMemory: "- fact",
    projectMemory: null,
    today: null,
    yesterday: null,
    dailyDates: ["2026-09-03", "2026-09-04"],
  });
  assert.ok(!block!.includes("Memory archive"));
});
