import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { MemoryPaths } from "./types.ts";

type Env = Record<string, string | undefined>;

/**
 * Global layout matches the ecosystem convention (~/.pi/agent/memory), so
 * existing MEMORY.md files from other memory extensions keep working.
 * PI_MEMORY_DIR overrides for tests and non-standard setups.
 */
export function resolvePaths(cwd: string, env: Env = process.env): MemoryPaths {
  const globalDir =
    env.PI_MEMORY_DIR ??
    join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "memory");
  const projectDir = join(cwd, ".pi", "memory");
  return {
    globalDir,
    globalMemory: join(globalDir, "MEMORY.md"),
    dailyDir: join(globalDir, "daily"),
    recoveryDir: join(globalDir, "recovery"),
    projectDir,
    projectMemory: join(projectDir, "MEMORY.md"),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Daily logs are keyed by the user's LOCAL calendar day — toISOString() is
 * UTC and files evening writes under tomorrow's date (jayzeng's bug report).
 */
export function localDateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function yesterdayStr(from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

export function localTimeStr(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function dailyFile(dailyDir: string, dateStr: string): string {
  return join(dailyDir, `${dateStr}.md`);
}

/**
 * A value that becomes a filename inside the memory store — a daily date, a
 * recovery id — must be a single, self-contained path component. The command
 * routes only ever build these from a strict shape (`YYYY-MM-DD`, a UUID); the
 * model-facing tools take free-form arguments, so they call this to guarantee
 * the same thing: no path separator, no drive/absolute prefix, no `..`
 * traversal, no NUL. Anything else could steer a read or write outside the
 * store. Returns the trimmed component; throws otherwise.
 */
export function assertSafeComponent(kind: string, value: string): string {
  const v = value.trim();
  if (
    v === "" ||
    v === "." ||
    v === ".." ||
    v.includes("/") ||
    v.includes("\\") ||
    v.includes(":") ||
    v.includes("\0") ||
    isAbsolute(v)
  ) {
    throw new Error(`Invalid ${kind} ${JSON.stringify(value)}: must be a plain name, not a path.`);
  }
  return v;
}
