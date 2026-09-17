/**
 * Worker for the concurrent-append regression test (store.test.ts). Two of
 * these run at once against the same global MEMORY.md; each appends `count`
 * entries tagged with its own letter. The read-modify-write appendEntry used
 * to lose one writer's entries entirely under this contention.
 *
 * Not a `*.test.*` file, so `bun test` does not collect it as a suite.
 */
import { resolvePaths } from "../src/paths.ts";
import { appendEntry } from "../src/store.ts";

const [cwd, tag, countRaw] = process.argv.slice(2);
if (!cwd || !tag || !countRaw) {
  console.error("usage: concurrent-append-worker <cwd> <tag> <count>");
  process.exit(2);
}
const count = Number(countRaw);
const paths = resolvePaths(cwd, process.env);
for (let i = 0; i < count; i++) {
  appendEntry(paths, "global", `${tag}-${i}`);
}
