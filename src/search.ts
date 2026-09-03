import { ftsAvailable, ftsSearch } from "./fts.ts";
import { scanSearch, type ScanDoc } from "./scan.ts";
import type { SearchResult } from "./types.ts";

/**
 * Search orchestrator: FTS5/BM25 when the runtime has node:sqlite (Node 24+,
 * Bun), zero-dep paragraph scan otherwise. Both engines see the same docs and
 * return the same hit shape, so callers never care which ran.
 */
export async function searchMemory(
  docs: ScanDoc[],
  query: string,
  limit = 8,
): Promise<SearchResult> {
  if (await ftsAvailable()) {
    try {
      const hits = await ftsSearch(docs, query, limit);
      if (hits.length > 0) return { engine: "fts5", hits };
      // FTS found nothing — the scan's substring matching is more forgiving
      // (partial words, hyphenated terms), so give it a chance before "no hits".
      return { engine: "fts5", hits: scanSearch(docs, query, limit) };
    } catch {
      // Corrupt query or engine hiccup: never fail a search over a fallback.
    }
  }
  return { engine: "scan", hits: scanSearch(docs, query, limit) };
}
