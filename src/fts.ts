import type { SearchHit } from "./types.ts";
import type { ScanDoc } from "./scan.ts";

/**
 * BM25 full-text search via node:sqlite FTS5 — compiled into Node >= 24
 * (and Bun), zero external dependencies (samfoy's pi-session-search insight).
 * Feature-detected at runtime; Node 22 hosts fall back to scan.ts.
 *
 * The index is built in-memory per process and invalidated on writes: the
 * corpus is megabytes at most, so a rebuild is cheaper than maintaining a
 * persistent index file with migrations.
 */

interface SqliteModule {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
    close(): void;
  };
}

let sqlite: SqliteModule | null | undefined;

export async function ftsAvailable(): Promise<boolean> {
  if (sqlite !== undefined) return sqlite !== null;
  try {
    const mod = (await import("node:sqlite")) as unknown as SqliteModule;
    const db = new mod.DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(x)");
    db.close();
    sqlite = mod;
    return true;
  } catch {
    sqlite = null;
    return false;
  }
}

/** Escape a user query into FTS5 phrase syntax (each term quoted, OR'd). */
export function toFtsQuery(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter((t) => t.length > 1);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export async function ftsSearch(
  docs: ScanDoc[],
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  if (!(await ftsAvailable()) || !sqlite) return [];
  const db = new sqlite.DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE mem USING fts5(file, line, body)");
    const insert = db.prepare("INSERT INTO mem (file, line, body) VALUES (?, ?, ?)");

    for (const doc of docs) {
      // Paragraph-level rows so hits point at a specific block, not a file.
      const lines = doc.content.split("\n");
      let start = 0;
      let buffer: string[] = [];
      for (let i = 0; i <= lines.length; i++) {
        const line = lines[i];
        if (line === undefined || line.trim() === "") {
          if (buffer.length > 0) {
            insert.run(doc.file, String(start + 1), buffer.join("\n"));
            buffer = [];
          }
          start = i + 1;
        } else {
          if (buffer.length === 0) start = i;
          buffer.push(line);
        }
      }
    }

    const rows = db
      .prepare(
        "SELECT file, line, snippet(mem, 2, '', '', '…', 24) AS snip, bm25(mem) AS rank " +
          "FROM mem WHERE mem MATCH ? ORDER BY rank LIMIT ?",
      )
      .all(toFtsQuery(query), limit) as Array<{
      file: string;
      line: string;
      snip: string;
      rank: number;
    }>;

    // bm25() returns lower-is-better; normalize to higher-is-better score.
    return rows.map((r) => ({
      file: r.file,
      line: Number.parseInt(r.line, 10) || 1,
      snippet: r.snip,
      score: -r.rank,
    }));
  } finally {
    db.close();
  }
}
