import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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
 * Append one line to a memory file without the read-modify-write that loses a
 * concurrent writer's entry.
 *
 * `~/.pi/agent/memory/MEMORY.md` and today's daily log are shared by every pi
 * process on the machine. The old "read whole file, concatenate, writeFileSync
 * it back" would let two sessions each read N lines and each write N+1 — the
 * second write silently discarding the first's entry, and worse, the truncate
 * that precedes writeFileSync could leave a collided read seeing an empty file
 * and rewrite MEMORY.md down to header + one line. An OS-level append is not
 * clobbered by a concurrent appender (worst case is a stray blank line), so
 * durable memory survives two sessions saving at once.
 */
function appendLine(file: string, header: string, entry: string): void {
  const existing = readFileSafe(file);

  // A truly new file gets its header written atomically. If a concurrent
  // writer created it first (EEXIST), fall through to the append branch rather
  // than clobbering the header and entry it just wrote.
  if (existing === null) {
    try {
      writeFileSync(file, `${header}${entry}\n`, { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
  } else if (existing.trim() === "") {
    // Existing but empty (or whitespace only): restore the header rather than
    // appending a headerless bullet.
    writeFileSync(file, `${header}${entry}\n`);
    return;
  }

  // Existing non-empty file, or one that appeared during the creation race.
  const current = existing ?? readFileSafe(file) ?? "";
  appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${entry}\n`);
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
  const header =
    scope === "daily"
      ? `# Daily log ${localDateStr()}\n\n`
      : scope === "project"
        ? "# Project memory\n\n"
        : "# Long-term memory\n\n";
  appendLine(file, header, entry);
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

  // First pass: scan every target file and collect the removals plus the
  // rewritten content, WITHOUT touching disk. A crash anywhere in this pass
  // loses nothing — no memory file has been altered yet.
  const removals: RecoveryRecord["removals"] = [];
  const pending: Array<{ file: string; kept: string }> = [];

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
    if (removedHere > 0) pending.push({ file, kept: kept.join("\n") });
  }

  if (removals.length === 0) return { recoveryId: null, removed: 0, files: [] };

  // The recovery record is written BEFORE any memory file is rewritten, so a
  // crash mid-rewrite always leaves the undo record on disk: forget is always
  // undoable (README promise).
  ensureDirs(paths);
  const record: RecoveryRecord = { id: randomUUID(), timestamp: Date.now(), removals };
  writeFileSync(join(paths.recoveryDir, `${record.id}.json`), JSON.stringify(record, null, 2));

  // Second pass: only now rewrite the files, with the undo record already safe.
  const touched: string[] = [];
  for (const { file, kept } of pending) {
    writeFileSync(file, kept);
    touched.push(file);
  }

  return { recoveryId: record.id, removed: removals.length, files: touched };
}

/**
 * Snapshot a whole file before it is rewritten (consolidation), so the same
 * /memory restore <id> path undoes it. Returns the recovery id.
 */
export function snapshotFile(paths: MemoryPaths, file: string, content: string): string {
  ensureDirs(paths);
  const record: RecoveryRecord = {
    id: randomUUID(),
    timestamp: Date.now(),
    removals: [],
    replacements: [{ file, content }],
  };
  writeFileSync(join(paths.recoveryDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  return record.id;
}

/**
 * Undo a recovery record: whole-file snapshots are put back by replacement,
 * forgotten lines by re-appending them.
 */
export function restore(paths: MemoryPaths, recoveryId: string): number {
  const file = join(paths.recoveryDir, `${recoveryId}.json`);
  const raw = readFileSafe(file);
  if (raw === null) throw new Error(`No recovery record ${recoveryId}.`);
  const record = JSON.parse(raw) as RecoveryRecord;
  let restored = 0;
  for (const replacement of record.replacements ?? []) {
    writeFileSync(replacement.file, replacement.content);
    restored++;
  }
  for (const removal of record.removals ?? []) {
    // The forgotten line already carries its own bullet; re-append it with the
    // same concurrency-safe helper (the header is only used on the rare empty
    // file — forget keeps the header, so the file it removed from still has one).
    appendLine(removal.file, "", removal.text);
    restored++;
  }
  return restored;
}
