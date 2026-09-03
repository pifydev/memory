import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dailyFile, localDateStr, localTimeStr } from "./paths.ts";
import type { MemoryPaths, MemoryScope, RecoveryRecord } from "./types.ts";

export function ensureDirs(paths: MemoryPaths): void {
  mkdirSync(paths.dailyDir, { recursive: true });
  mkdirSync(paths.recoveryDir, { recursive: true });
}

export function readFileSafe(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Target file for a write scope. Project files are created on demand. */
export function fileForScope(paths: MemoryPaths, scope: MemoryScope): string {
  switch (scope) {
    case "global":
      return paths.globalMemory;
    case "project":
      return paths.projectMemory;
    case "daily":
      return dailyFile(paths.dailyDir, localDateStr());
  }
}

/**
 * Append one memory entry as a markdown bullet. Daily entries carry a local
 * time prefix; MEMORY.md entries are timeless (they are durable facts).
 */
export function appendEntry(paths: MemoryPaths, scope: MemoryScope, text: string): string {
  ensureDirs(paths);
  const file = fileForScope(paths, scope);
  if (scope === "project") mkdirSync(paths.projectDir, { recursive: true });

  const entry = scope === "daily" ? `- ${localTimeStr()} ${text.trim()}` : `- ${text.trim()}`;
  const existing = readFileSafe(file);
  const header =
    scope === "daily"
      ? `# Daily log ${localDateStr()}\n\n`
      : scope === "project"
        ? "# Project memory\n\n"
        : "# Long-term memory\n\n";
  const next = existing
    ? `${existing.replace(/\n*$/, "\n")}${entry}\n`
    : `${header}${entry}\n`;
  writeFileSync(file, next);
  return file;
}

export function listDailyFiles(paths: MemoryPaths): string[] {
  try {
    return readdirSync(paths.dailyDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

/** Every memory file that exists, for search and forget sweeps. */
export function allMemoryFiles(paths: MemoryPaths): string[] {
  const files: string[] = [];
  if (existsSync(paths.globalMemory)) files.push(paths.globalMemory);
  if (existsSync(paths.projectMemory)) files.push(paths.projectMemory);
  for (const f of listDailyFiles(paths)) files.push(join(paths.dailyDir, f));
  return files;
}

export interface ForgetResult {
  recoveryId: string | null;
  removed: number;
  files: string[];
}

/**
 * Remove lines containing the pattern (case-insensitive substring) from all
 * memory files, writing a recovery record first so agent-initiated deletes
 * are always undoable (jayzeng's recovery design).
 */
export function forget(paths: MemoryPaths, pattern: string): ForgetResult {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return { recoveryId: null, removed: 0, files: [] };

  const removals: RecoveryRecord["removals"] = [];
  const touched: string[] = [];

  for (const file of allMemoryFiles(paths)) {
    const content = readFileSafe(file);
    if (content === null) continue;
    const lines = content.split("\n");
    const kept: string[] = [];
    let removedHere = 0;
    for (const line of lines) {
      // Only entry bullets are forgettable; headers/structure stay.
      if (line.trimStart().startsWith("-") && line.toLowerCase().includes(needle)) {
        removals.push({ file, text: line });
        removedHere++;
      } else {
        kept.push(line);
      }
    }
    if (removedHere > 0) {
      writeFileSync(file, kept.join("\n"));
      touched.push(file);
    }
  }

  if (removals.length === 0) return { recoveryId: null, removed: 0, files: [] };

  ensureDirs(paths);
  const record: RecoveryRecord = { id: randomUUID(), timestamp: Date.now(), removals };
  writeFileSync(join(paths.recoveryDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  return { recoveryId: record.id, removed: removals.length, files: touched };
}

/** Re-append the lines captured in a recovery record to their files. */
export function restore(paths: MemoryPaths, recoveryId: string): number {
  const file = join(paths.recoveryDir, `${recoveryId}.json`);
  const raw = readFileSafe(file);
  if (raw === null) throw new Error(`No recovery record ${recoveryId}.`);
  const record = JSON.parse(raw) as RecoveryRecord;
  let restored = 0;
  for (const removal of record.removals) {
    const content = readFileSafe(removal.file) ?? "";
    writeFileSync(removal.file, `${content.replace(/\n*$/, "\n")}${removal.text}\n`);
    restored++;
  }
  return restored;
}
