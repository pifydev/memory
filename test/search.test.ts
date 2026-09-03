import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSearch, tokenize } from "../src/scan.ts";
import { ftsAvailable, ftsSearch, toFtsQuery } from "../src/fts.ts";
import { searchMemory } from "../src/search.ts";

const DOCS = [
  {
    file: "MEMORY.md",
    content:
      "# Long-term memory\n\n- prefers pnpm over npm in every repo\n- deploy pipeline uses GitHub Actions\n\n- the staging database is postgres 16",
  },
  {
    file: "daily/2026-09-01.md",
    content: "# Daily log\n\n- 10:00 debugged the pnpm lockfile conflict\n\n- 11:00 lunch",
  },
];

test("tokenize drops punctuation and single chars", () => {
  assert.deepEqual(tokenize("How's the pnpm-lockfile? a b"), ["how", "the", "pnpm-lockfile"]);
});

test("scanSearch finds and ranks paragraph blocks", () => {
  const hits = scanSearch(DOCS, "pnpm lockfile", 5);
  assert.ok(hits.length >= 2);
  // The daily entry mentions both terms — it should outrank the MEMORY entry.
  assert.equal(hits[0]!.file, "daily/2026-09-01.md");
  assert.ok(hits[0]!.snippet.includes("lockfile"));
  assert.ok(hits[0]!.line > 0);
});

test("scanSearch returns empty for no-term queries", () => {
  assert.deepEqual(scanSearch(DOCS, "???", 5), []);
});

test("toFtsQuery quotes terms and strips embedded quotes", () => {
  assert.equal(toFtsQuery('pnpm "lockfile"'), '"pnpm" OR "lockfile"');
  assert.equal(toFtsQuery("x"), '""');
});

test("fts engine (when available) finds the same content", async () => {
  if (!(await ftsAvailable())) {
    // Node 22 fallback path — covered by scanSearch tests.
    return;
  }
  const hits = await ftsSearch(DOCS, "postgres staging", 5);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0]!.file, "MEMORY.md");
});

test("searchMemory always answers via some engine", async () => {
  const result = await searchMemory(DOCS, "github actions deploy", 5);
  assert.ok(["fts5", "scan"].includes(result.engine));
  assert.ok(result.hits.length >= 1);
  assert.ok(result.hits[0]!.snippet.toLowerCase().includes("github"));
});

test("searchMemory falls back to scan when fts misses partial words", async () => {
  const result = await searchMemory(DOCS, "lockf", 5);
  // "lockf" is a prefix — FTS5 exact-phrase misses it, scan substring finds it.
  assert.ok(result.hits.length >= 1);
});
