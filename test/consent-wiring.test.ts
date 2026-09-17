import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import memoryExtension from "../extensions/memory.ts";

/**
 * Wiring tests for the project-consent state machine, driven through the
 * extension's real event and command handlers against a minimal fake pi.
 *
 * f046: projectMemoryAllowed must not memoise "file does not exist" as a
 * refusal — a project file the agent creates mid-session has to be injected at
 * the next compaction rather than staying invisible until pi restarts.
 * f051: /memory status must report what injection would actually do, not just
 * whether the on-disk store holds a "memory" answer.
 */

interface Handlers {
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
  messages: Array<{ content: string; customType?: string }>;
}

function loadExtension(): Handlers {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
  const messages: Array<{ content: string; customType?: string }> = [];
  const pi = {
    on(evt: string, h: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(evt, h);
    },
    registerTool() {},
    registerCommand(name: string, spec: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, spec);
    },
    appendEntry() {},
    sendMessage(msg: { content: string; customType?: string }) {
      messages.push(msg);
    },
  };
  memoryExtension(pi as never);
  return { handlers, commands, messages };
}

function fakeCtx(cwd: string, notes: string[] = []) {
  return {
    cwd,
    hasUI: true,
    model: {},
    isProjectTrusted: () => true,
    ui: {
      confirm: async () => true,
      notify: (text: string) => notes.push(text),
    },
    sessionManager: {
      buildContextEntries: () => [],
      getBranch: () => [],
    },
  };
}

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a project file created mid-session is injected at the next compaction (f046)", async () => {
  const base = mkdtempSync(join(tmpdir(), "pify-consent-"));
  try {
    const cwd = join(base, "project");
    await withEnv(
      { PI_MEMORY_DIR: join(base, "global-memory"), PIFY_TRUST_PROJECT: "1" },
      async () => {
        const { handlers, messages } = loadExtension();
        const ctx = fakeCtx(cwd);

        // Session starts with no project file. The old code memoised this as a
        // permanent refusal for the whole process.
        await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
        assert.equal(messages.length, 0, "nothing to inject before any memory exists");

        // The agent creates the project file this session (memory_write scope=project).
        mkdirSync(join(cwd, ".pi", "memory"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "memory", "MEMORY.md"), "# Project memory\n\n- uses pnpm\n");

        // A compaction re-injects. The newly created file must now be included
        // — before the fix the memoised "false" omitted it.
        await handlers.get("session_compact")!({ type: "session_compact" }, ctx);
        assert.equal(messages.length, 1, "the newly created project file is injected at compaction");
        assert.match(messages[0]!.content, /uses pnpm/);
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("/memory status reports (no project file) and injected, not a stale refusal (f051)", async () => {
  const base = mkdtempSync(join(tmpdir(), "pify-consent-"));
  try {
    const cwd = join(base, "project");
    await withEnv(
      { PI_MEMORY_DIR: join(base, "global-memory"), PIFY_TRUST_PROJECT: "1", PIFY_MEMORY_OBSERVE: undefined },
      async () => {
        const { commands } = loadExtension();
        const status = commands.get("memory")!;

        // No project file yet.
        const noFile: string[] = [];
        await status.handler("", fakeCtx(cwd, noFile));
        const noFileText = noFile.join("\n");
        assert.match(noFileText, /\(no project file\)/);
        assert.ok(!/NOT injected/.test(noFileText), "a missing file is not a refusal");

        // File present + env override => injected.
        mkdirSync(join(cwd, ".pi", "memory"), { recursive: true });
        writeFileSync(join(cwd, ".pi", "memory", "MEMORY.md"), "# Project memory\n\n- uses pnpm\n");
        const withFile: string[] = [];
        await status.handler("", fakeCtx(cwd, withFile));
        const withFileText = withFile.join("\n");
        assert.match(withFileText, /project .* — injected/);
        assert.ok(!/not yet asked|NOT injected/.test(withFileText), "the env override injects the file");
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
