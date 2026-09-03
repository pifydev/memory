/**
 * @pify/memory — persistent memory across pi sessions.
 *
 * Plain-markdown storage the user can read, edit, and commit: a global
 * MEMORY.md + daily logs under ~/.pi/agent/memory (ecosystem-compatible
 * layout) and a per-project .pi/memory/MEMORY.md. Explicit learning only —
 * the agent saves when the user asks or when something durable emerges; no
 * LLM calls at shutdown. Search runs on BM25/FTS5 via node:sqlite when the
 * runtime has it (Node 24+, Bun), with a zero-dep scan fallback. A secret
 * gate blocks credentials from ever entering memory. Context is injected
 * once per session as a hidden custom message (cache-stable).
 *
 * Design synthesis: file layout, forget/recovery, local-date discipline
 * (jayzeng/pi-memory); cache-aware one-shot injection (@samfp/pi-memory);
 * node:sqlite FTS5 + archive overview injection (samfoy/pi-session-search,
 * pi-knowledge-search); secret scanning (pi-hermes-memory).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { buildInjectBlock } from "../src/inject.ts";
import { dailyFile, localDateStr, resolvePaths, yesterdayStr } from "../src/paths.ts";
import { ftsAvailable } from "../src/fts.ts";
import { searchMemory } from "../src/search.ts";
import { assertNoSecrets } from "../src/secrets.ts";
import {
  allMemoryFiles,
  appendEntry,
  ensureDirs,
  forget,
  listDailyFiles,
  readFileSafe,
  restore,
} from "../src/store.ts";
import type { MemoryPaths, MemoryScope } from "../src/types.ts";

const MEMORY_CONTEXT_TYPE = "memory-context";

export default function memoryExtension(pi: ExtensionAPI) {
  let paths: MemoryPaths | null = null;

  function requirePaths(ctx: { cwd: string }): MemoryPaths {
    if (!paths) paths = resolvePaths(ctx.cwd);
    return paths;
  }

  function loadDocs(p: MemoryPaths) {
    return allMemoryFiles(p)
      .map((file) => ({ file, content: readFileSafe(file) ?? "" }))
      .filter((d) => d.content.trim() !== "");
  }

  // ── Injection: once per session, hidden, before any user message ─────

  pi.on("session_start", async (_event, ctx) => {
    const p = requirePaths(ctx);
    ensureDirs(p);

    // Dedupe across /reload and resume: if this branch already carries a
    // memory-context message, do not inject another (stale-but-stable beats
    // duplicated blocks; mid-session writes are visible in the transcript).
    const alreadyInjected = ctx.sessionManager
      .getBranch()
      .some((entry) => (entry as { customType?: string }).customType === MEMORY_CONTEXT_TYPE);
    if (alreadyInjected) return;

    const block = buildInjectBlock({
      globalMemory: readFileSafe(p.globalMemory),
      projectMemory: readFileSafe(p.projectMemory),
      today: readFileSafe(dailyFile(p.dailyDir, localDateStr())),
      yesterday: readFileSafe(dailyFile(p.dailyDir, yesterdayStr())),
      dailyDates: listDailyFiles(p).map((f) => f.replace(/\.md$/, "")),
    });
    if (block) {
      pi.sendMessage({ customType: MEMORY_CONTEXT_TYPE, content: block, display: false });
    }
  });

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_write",
    label: "Memory write",
    description:
      "Save one durable memory entry. scope=global for cross-project facts and preferences, " +
      "scope=project for facts about this repository, scope=daily for a dated activity log entry. " +
      "Save when the user asks you to remember something or corrects you in a way that should stick. " +
      "Never save credentials — writes are secret-scanned and rejected.",
    parameters: Type.Object({
      scope: StringEnum(["global", "project", "daily"] as const),
      text: Type.String({ description: "One concise entry (a sentence or two)" }),
    }),
    async execute(_id, params: { scope: MemoryScope; text: string }, _signal, _onUpdate, ctx) {
      const text = params.text.trim();
      if (!text) throw new Error("memory_write requires non-empty text.");
      assertNoSecrets(text);
      const file = appendEntry(requirePaths(ctx as ExtensionContext), params.scope, text);
      return {
        content: [{ type: "text", text: `Saved to ${file}` }],
        details: { file, scope: params.scope },
      };
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory read",
    description:
      "Read a memory file in full: target=global|project reads that MEMORY.md, target=daily reads a " +
      "dated log (date defaults to today, format YYYY-MM-DD), target=list lists available daily logs.",
    parameters: Type.Object({
      target: StringEnum(["global", "project", "daily", "list"] as const),
      date: Type.Optional(Type.String({ description: "YYYY-MM-DD, for target=daily" })),
    }),
    async execute(_id, params: { target: string; date?: string }, _signal, _onUpdate, ctx) {
      const p = requirePaths(ctx as ExtensionContext);
      if (params.target === "list") {
        const files = listDailyFiles(p);
        return {
          content: [{ type: "text", text: files.length ? files.join("\n") : "No daily logs yet." }],
          details: { count: files.length },
        };
      }
      const file =
        params.target === "global"
          ? p.globalMemory
          : params.target === "project"
            ? p.projectMemory
            : dailyFile(p.dailyDir, params.date?.trim() || localDateStr());
      const content = readFileSafe(file);
      return {
        content: [{ type: "text", text: content ?? `(empty — ${file} does not exist yet)` }],
        details: { file },
      };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory search",
    description:
      "Full-text search across all memory files (global, project, and every daily log). " +
      "Use before assuming something was never recorded.",
    parameters: Type.Object({
      query: Type.String({ description: "Keywords to search for" }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
    }),
    async execute(_id, params: { query: string; limit?: number }, _signal, _onUpdate, ctx) {
      const p = requirePaths(ctx as ExtensionContext);
      const result = await searchMemory(loadDocs(p), params.query, params.limit ?? 8);
      const text =
        result.hits.length === 0
          ? "No matches."
          : result.hits
              .map((h) => `${h.file}:${h.line}\n${h.snippet}`)
              .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text }],
        details: { engine: result.engine, count: result.hits.length },
      };
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory forget",
    description:
      "Delete memory entries whose text contains the pattern (case-insensitive), across all memory " +
      "files. A recovery record is written first; report the recoveryId to the user so the deletion " +
      "can be undone with memory_restore.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Substring identifying the entries to delete" }),
    }),
    async execute(_id, params: { pattern: string }, _signal, _onUpdate, ctx) {
      const result = forget(requirePaths(ctx as ExtensionContext), params.pattern);
      const text =
        result.removed === 0
          ? "No matching entries."
          : `Removed ${result.removed} entr${result.removed > 1 ? "ies" : "y"} from ${result.files.length} file(s). Recovery id: ${result.recoveryId}`;
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "memory_restore",
    label: "Memory restore",
    description: "Undo a memory_forget deletion using its recovery id.",
    parameters: Type.Object({
      recoveryId: Type.String(),
    }),
    async execute(_id, params: { recoveryId: string }, _signal, _onUpdate, ctx) {
      const restored = restore(requirePaths(ctx as ExtensionContext), params.recoveryId.trim());
      return {
        content: [{ type: "text", text: `Restored ${restored} entr${restored > 1 ? "ies" : "y"}.` }],
        details: { restored },
      };
    },
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("memory", {
    description: "Show memory status and file locations",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const p = requirePaths(ctx);
      const dailies = listDailyFiles(p);
      const sizeOf = (f: string) => {
        const c = readFileSafe(f);
        return c === null ? "—" : `${c.length} chars`;
      };
      const engine = (await ftsAvailable()) ? "FTS5 (node:sqlite, BM25)" : "scan (zero-dep fallback)";
      ctx.ui.notify(
        [
          "Memory status",
          `  global   ${p.globalMemory} (${sizeOf(p.globalMemory)})`,
          `  project  ${p.projectMemory} (${sizeOf(p.projectMemory)})`,
          `  daily    ${dailies.length} log(s) in ${p.dailyDir}`,
          `  search   ${engine}`,
          "Tools: memory_write · memory_read · memory_search · memory_forget · memory_restore",
        ].join("\n"),
        "info",
      );
    },
  });
}
