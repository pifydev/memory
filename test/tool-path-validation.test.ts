import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryExtension from "../extensions/memory.ts";
import { assertSafeComponent } from "../src/paths.ts";

/**
 * The model-facing memory_read / memory_restore tools take free-form arguments
 * that become filenames inside the memory store. The command routes only ever
 * build these from a strict shape (YYYY-MM-DD, a UUID); the tools must enforce
 * the same guarantee, or a traversal argument steers a read/write outside the
 * store. These regression tests drive the *registered* tools, so they also pin
 * the wiring — before the fix the tools skipped this check entirely.
 */

interface Tool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<unknown>;
}

/** Instantiate the extension against a mock host and collect its tools. */
function loadTools(): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const pi = {
    on() {},
    registerTool(spec: Tool) {
      tools.set(spec.name, spec);
    },
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  };
  // The extension type is the pi host API; the mock only implements what the
  // synchronous registration path touches.
  memoryExtension(pi as never);
  return tools;
}

const TRAVERSAL = [
  "../../../etc/passwd",
  "..\\..\\..\\windows\\system32",
  "/etc/passwd",
  "a/b",
  "..",
];

test("memory_restore rejects traversal / absolute recovery ids", async () => {
  const tools = loadTools();
  const restore = tools.get("memory_restore")!;
  assert.ok(restore, "memory_restore is registered");
  for (const bad of TRAVERSAL) {
    await assert.rejects(
      () => restore.execute("id", { recoveryId: bad }, undefined, undefined, { cwd: process.cwd() }),
      /Invalid recovery id/,
      `must reject recoveryId ${JSON.stringify(bad)}`,
    );
  }
});

test("memory_restore lets a plain recovery id past the guard", async () => {
  const base = mkdtempSync(join(tmpdir(), "pify-toolval-"));
  const prev = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = join(base, "global-memory");
  try {
    const restore = loadTools().get("memory_restore")!;
    // A well-formed id gets past validation and fails only because no such
    // record exists — proving the guard does not over-reject legitimate ids.
    await assert.rejects(
      () =>
        restore.execute(
          "id",
          { recoveryId: "3f0c9a2e-1234-4a5b-8c9d-abcdef012345" },
          undefined,
          undefined,
          { cwd: join(base, "project") },
        ),
      /No recovery record/,
    );
  } finally {
    if (prev === undefined) delete process.env.PI_MEMORY_DIR;
    else process.env.PI_MEMORY_DIR = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test("memory_read rejects a traversal date", async () => {
  const tools = loadTools();
  const read = tools.get("memory_read")!;
  assert.ok(read, "memory_read is registered");
  for (const bad of ["../../secrets", "..\\..\\secrets", "/etc/hosts"]) {
    await assert.rejects(
      () => read.execute("id", { target: "daily", date: bad }, undefined, undefined, { cwd: process.cwd() }),
      /date must be YYYY-MM-DD/,
      `must reject date ${JSON.stringify(bad)}`,
    );
  }
});

test("memory_read accepts a well-formed date", async () => {
  const base = mkdtempSync(join(tmpdir(), "pify-toolval-"));
  const prev = process.env.PI_MEMORY_DIR;
  process.env.PI_MEMORY_DIR = join(base, "global-memory");
  try {
    const read = loadTools().get("memory_read")!;
    // A valid date is accepted; the log does not exist yet, so it reads empty.
    const result = (await read.execute(
      "id",
      { target: "daily", date: "2026-09-04" },
      undefined,
      undefined,
      { cwd: join(base, "project") },
    )) as { content: Array<{ text: string }> };
    assert.match(result.content[0]!.text, /empty/);
  } finally {
    if (prev === undefined) delete process.env.PI_MEMORY_DIR;
    else process.env.PI_MEMORY_DIR = prev;
    rmSync(base, { recursive: true, force: true });
  }
});

test("assertSafeComponent guards separators, traversal, absolutes; passes plain names", () => {
  assert.equal(assertSafeComponent("recovery id", "  abc-123  "), "abc-123");
  assert.equal(assertSafeComponent("date", "2026-09-04"), "2026-09-04");
  for (const bad of ["", ".", "..", "a/b", "a\\b", "/x", "C:\\x", "x:y", "a\0b"]) {
    assert.throws(() => assertSafeComponent("thing", bad), /Invalid thing/, `must reject ${JSON.stringify(bad)}`);
  }
});
