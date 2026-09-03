import type { SearchHit } from "./types.ts";

/**
 * Zero-dependency fallback search: paragraph-level keyword scoring.
 * Used when node:sqlite FTS5 is unavailable (Node 22 hosts).
 */

export interface ScanDoc {
  file: string;
  content: string;
}

interface Block {
  file: string;
  line: number;
  text: string;
}

function splitBlocks(doc: ScanDoc): Block[] {
  const blocks: Block[] = [];
  const lines = doc.content.split("\n");
  let start = 0;
  let buffer: string[] = [];
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") {
      if (buffer.length > 0) {
        blocks.push({ file: doc.file, line: start + 1, text: buffer.join("\n") });
        buffer = [];
      }
      start = i + 1;
    } else {
      if (buffer.length === 0) start = i;
      buffer.push(line);
    }
  }
  return blocks;
}

export function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((t) => t.length > 1);
}

/** Score = term hits weighted by term rarity-ish (longer terms worth more). */
function scoreBlock(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let idx = haystack.indexOf(term);
    while (idx !== -1) {
      score += Math.min(4, 1 + term.length / 4);
      idx = haystack.indexOf(term, idx + term.length);
    }
  }
  return score;
}

export function scanSearch(docs: ScanDoc[], query: string, limit: number): SearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const doc of docs) {
    for (const block of splitBlocks(doc)) {
      const score = scoreBlock(block.text, terms);
      if (score > 0) {
        hits.push({
          file: block.file,
          line: block.line,
          snippet: block.text.length > 400 ? `${block.text.slice(0, 400)}…` : block.text,
          score,
        });
      }
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
