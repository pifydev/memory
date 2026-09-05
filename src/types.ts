/**
 * Local structural types for @pify/memory.
 * No imports from pi packages: src/ typechecks and runs standalone so tests
 * execute under bun/node without a pi host.
 */

export type MemoryScope = "global" | "project" | "daily";

export interface MemoryPaths {
  /** Global memory root, e.g. ~/.pi/agent/memory (jayzeng-compatible layout). */
  globalDir: string;
  globalMemory: string;
  dailyDir: string;
  recoveryDir: string;
  /** Project memory root, .pi/memory under the working directory. */
  projectDir: string;
  projectMemory: string;
}

export interface SearchHit {
  file: string;
  /** 1-based line number of the block start. */
  line: number;
  snippet: string;
  score: number;
}

export interface SearchResult {
  engine: "qmd" | "fts5" | "scan";
  hits: SearchHit[];
}

export interface SecretMatch {
  label: string;
  /** Redacted preview of what matched, safe to show. */
  preview: string;
}

export interface RecoveryRecord {
  id: string;
  timestamp: number;
  removals: Array<{ file: string; text: string }>;
  /** Whole-file snapshots (v0.3 consolidation): restored by replacement. */
  replacements?: Array<{ file: string; content: string }>;
}

/** Injection caps: memory must never crowd out the actual conversation. */
export const MAX_INJECT_CHARS_PER_FILE = 6000;
export const MAX_DAILY_INJECT_CHARS = 3000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
