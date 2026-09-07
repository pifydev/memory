import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RECALL_LIMIT,
  extractLessons,
  formatLesson,
  isLessonCategory,
  lessonsBlock,
  recallLessons,
} from "../src/lessons.ts";
import { buildInjectBlock } from "../src/inject.ts";

test("a lesson is stored as a readable bullet, not a sidecar record", () => {
  assert.equal(formatLesson("failure", "  bun test hangs on Windows CI  "), "[failure] bun test hangs on Windows CI");
  assert.ok(isLessonCategory("tool-quirk"));
  assert.ok(!isLessonCategory("wat"));
  assert.ok(!isLessonCategory(undefined));
});

test("extractLessons reads categories out of plain markdown", () => {
  const daily = [
    "# Daily log 2026-09-06",
    "",
    "- 09:15 [failure] npm ci fails behind the proxy — use --offline",
    "- 10:02 ordinary entry with no category",
    "- [correction] the user prefers spaces, not tabs",
    "- [nonsense] not a category we know",
    "* [insight] the parser is the slow part",
    "not a bullet at all",
  ].join("\n");

  const lessons = extractLessons("/m/daily/2026-09-06.md", daily);
  assert.deepEqual(
    lessons.map((l) => `${l.category}:${l.text}`),
    [
      "failure:npm ci fails behind the proxy — use --offline",
      "correction:the user prefers spaces, not tabs",
      "insight:the parser is the slow part",
    ],
  );
  // the daily date rides along, so recall can age entries out
  assert.equal(lessons[0]!.date, "2026-09-06");
  // a non-daily file has no date and never ages out
  assert.equal(extractLessons("/m/MEMORY.md", "- [failure] x")[0]!.date, null);
});

test("recall surfaces the repeat-preventing categories, newest first", () => {
  const today = new Date(2026, 8, 7);
  const lessons = [
    { category: "failure" as const, text: "old failure", file: "f", date: "2026-09-01" },
    { category: "correction" as const, text: "newer correction", file: "f", date: "2026-09-06" },
    { category: "insight" as const, text: "an insight", file: "f", date: "2026-09-06" },
    { category: "preference" as const, text: "a preference", file: "f", date: "2026-09-06" },
  ];
  const recalled = recallLessons(lessons, { today });
  assert.deepEqual(
    recalled.map((l) => l.text),
    ["newer correction", "old failure"],
    "insights and preferences are searchable but not pushed",
  );
});

test("recall drops what is too old, and keeps undated entries", () => {
  const today = new Date(2026, 8, 7);
  const stale = { category: "failure" as const, text: "a year ago", file: "f", date: "2025-09-07" };
  const undated = { category: "failure" as const, text: "from MEMORY.md", file: "m", date: null };
  const recalled = recallLessons([stale, undated], { today, maxAgeDays: 30 });
  assert.deepEqual(recalled.map((l) => l.text), ["from MEMORY.md"]);
  // a wider window brings the old one back
  assert.equal(recallLessons([stale], { today, maxAgeDays: 400 }).length, 1);
});

test("recall is bounded so memory cannot crowd out the conversation", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    category: "failure" as const,
    text: `failure ${i}`,
    file: "f",
    date: "2026-09-06",
  }));
  assert.equal(recallLessons(many, { today: new Date(2026, 8, 7) }).length, DEFAULT_RECALL_LIMIT);
  assert.equal(recallLessons(many, { limit: 0, today: new Date(2026, 8, 7) }).length, 0);
});

test("the lessons block says why it is there, or is absent entirely", () => {
  assert.equal(lessonsBlock([]), null);
  const block = lessonsBlock([{ category: "failure", text: "x fails", file: "f", date: null }])!;
  assert.ok(block.includes("should not be repeated"));
  assert.ok(block.includes("- [failure] x fails"));
});

test("v0.5 the injected block tells the agent that current evidence wins", () => {
  const block = buildInjectBlock({
    globalMemory: "- a fact",
    projectMemory: null,
    today: null,
    yesterday: null,
    dailyDates: [],
    lessons: lessonsBlock([{ category: "failure", text: "the build breaks on node 20", file: "f", date: null }]),
  })!;
  assert.ok(block.includes("prefer what you can see"));
  assert.ok(block.includes("memory disagreed"));
  assert.ok(block.includes("should not be repeated"));
  assert.ok(block.includes("[failure] the build breaks on node 20"));

  // no lessons, no section
  const plain = buildInjectBlock({
    globalMemory: "- a fact",
    projectMemory: null,
    today: null,
    yesterday: null,
    dailyDates: [],
  })!;
  assert.ok(!plain.includes("should not be repeated"));
});
