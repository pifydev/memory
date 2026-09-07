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
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  LESSON_CATEGORIES,
  extractLessons,
  formatLesson,
  lessonsBlock,
  recallLessons,
  type LessonCategory,
} from "../src/lessons.ts";
import {
  CONSOLIDATE_SYSTEM_PROMPT,
  assessConsolidation,
  buildConsolidatePrompt,
  bulletsOf,
  consolidationPreview,
  parseConsolidation,
} from "../src/consolidate.ts";
import { buildInjectBlock } from "../src/inject.ts";
import {
  consentQuestion,
  decideConsent,
  envConsent,
  parseConsent,
  readConsent,
  writeConsent,
} from "../src/consent.ts";
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
  snapshotFile,
} from "../src/store.ts";
import type { MemoryPaths, MemoryScope } from "../src/types.ts";

const MEMORY_CONTEXT_TYPE = "memory-context";
const CONSOLIDATE_TIMEOUT_MS = 180_000;
/** Below this, consolidation cannot pay for its own model call. */
const MIN_ENTRIES_TO_CONSOLIDATE = 4;

export default function memoryExtension(pi: ExtensionAPI) {
  let paths: MemoryPaths | null = null;

  function requirePaths(ctx: { cwd: string }): MemoryPaths {
    if (!paths) paths = resolvePaths(ctx.cwd);
    return paths;
  }

  /** Where the suite records which projects you approved, and for what. */
  function consentFile(): string {
    return join(getAgentDir(), "pify-project-consent.json");
  }

  /**
   * May this repository's own memory file be injected? pi never asked about
   * it — `.pi/memory/MEMORY.md` is not one of the resources pi loads — so the
   * question is ours to put, once per project.
   */
  async function projectMemoryAllowed(ctx: ExtensionContext, p: MemoryPaths): Promise<boolean> {
    if (!existsSync(p.projectMemory)) return false;
    const file = consentFile();
    const store = parseConsent(readFileSafe(file));
    const verdict = decideConsent({
      projectTrusted: ctx.isProjectTrusted(),
      remembered: readConsent(store, ctx.cwd, "memory"),
      hasUI: ctx.hasUI,
      envOverride: envConsent(process.env),
    });
    if (verdict !== "ask") return verdict === "allow";

    const approved = await ctx.ui.confirm(
      "Load this project's memory?",
      consentQuestion("its own memory file, which is injected before your first prompt", p.projectMemory),
    );
    try {
      writeFileSync(file, `${JSON.stringify(writeConsent(store, ctx.cwd, "memory", approved), null, 2)}
`);
    } catch {
      // An unwritable consent file costs us the memory of the answer, not the answer.
    }
    return approved;
  }

  function loadDocs(p: MemoryPaths) {
    return allMemoryFiles(p)
      .map((file) => ({ file, content: readFileSafe(file) ?? "" }))
      .filter((d) => d.content.trim() !== "");
  }

  /** Resolve a consolidation target to its file, or null when unknown. */
  function targetFile(p: MemoryPaths, target: string): string | null {
    if (target === "global") return p.globalMemory;
    if (target === "project") return p.projectMemory;
    if (/^\d{4}-\d{2}-\d{2}$/.test(target)) return dailyFile(p.dailyDir, target);
    return null;
  }

  /**
   * Ask a model to fold duplicates and superseded facts together, then show
   * the user exactly what would change. Nothing is written without an
   * explicit yes, and the previous content is kept as a recovery record —
   * this is the one place where an LLM touches memory the user owns.
   */
  async function runConsolidate(ctx: ExtensionCommandContext, p: MemoryPaths, target: string): Promise<void> {
    const file = targetFile(p, target);
    if (!file) {
      ctx.ui.notify("Usage: /memory consolidate <global|project|YYYY-MM-DD>", "warning");
      return;
    }
    const before = readFileSafe(file);
    if (before === null || before.trim() === "") {
      ctx.ui.notify(`Nothing to consolidate — ${file} is empty.`, "warning");
      return;
    }
    if (bulletsOf(before).length < MIN_ENTRIES_TO_CONSOLIDATE) {
      ctx.ui.notify(
        `Only ${bulletsOf(before).length} entr(ies) in ${file} — not worth a model call yet.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(`Consolidating ${file}…`, "info");
    let session: AgentSession | null = null;
    let answer = "";
    try {
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(ctx.cwd),
        model: ctx.model as never,
        // No tools: this is a pure text transformation of content we hand it.
        tools: [],
        resourceLoader: new DefaultResourceLoader({
          cwd: ctx.cwd,
          agentDir: getAgentDir(),
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
          appendSystemPrompt: [CONSOLIDATE_SYSTEM_PROMPT],
        } as never),
      });
      session = created.session;
      await session.prompt(buildConsolidatePrompt(target, before), {
        signal: AbortSignal.timeout(CONSOLIDATE_TIMEOUT_MS),
      } as never);
      const messages = session.messages as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      answer = (last?.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    } catch (err) {
      ctx.ui.notify(`Consolidation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    } finally {
      try {
        session?.dispose();
      } catch {
        // best-effort
      }
    }

    const after = parseConsolidation(answer);
    if (!after) {
      ctx.ui.notify("The model did not return a usable markdown block — nothing was changed.", "warning");
      return;
    }
    const assessment = assessConsolidation(before, after);
    if (!assessment.ok) {
      ctx.ui.notify(
        [
          `Refused the proposal: ${assessment.reason}.`,
          ...assessment.invented.slice(0, 3).map((line) => `  invented: ${line.slice(0, 90)}`),
          "Nothing was changed.",
        ].join("\n"),
        "warning",
      );
      return;
    }
    // The consolidated text goes back into a file that is re-injected every
    // session, so it passes the same secret gate as any other write.
    try {
      assertNoSecrets(after);
    } catch (err) {
      ctx.ui.notify(`Refused: ${err instanceof Error ? err.message : String(err)}`, "error");
      return;
    }

    const approved = await ctx.ui.confirm(
      "Apply consolidation",
      `${consolidationPreview(before, after)}\n\nWrite this to ${file}?`,
    );
    if (!approved) {
      ctx.ui.notify("Consolidation discarded.", "info");
      return;
    }

    const recoveryId = snapshotFile(p, file, before);
    writeFileSync(file, after.endsWith("\n") ? after : `${after}\n`);
    ctx.ui.notify(
      [
        `Consolidated ${file}.`,
        `${assessment.removedCount} entr${assessment.removedCount === 1 ? "y" : "ies"} folded in, ${assessment.keptCount} kept.`,
        recoveryId ? `Undo with: /memory restore ${recoveryId}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "info",
    );
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

    // `.pi/memory/MEMORY.md` is shipped by the repository, and this block is
    // injected before your first prompt in every session — a repo you had just
    // cloned would otherwise get to put text in front of the model on its own
    // say-so.
    const projectTrusted = await projectMemoryAllowed(ctx, p);

    // Recent failures and corrections come along unprompted: a lesson that
    // has to be searched for is a lesson that gets repeated. Lessons from the
    // untrusted project file are held back for the same reason its memory is.
    const lessons = recallLessons(
      loadDocs(p)
        .filter((doc) => projectTrusted || doc.file !== p.projectMemory)
        .flatMap((doc) => extractLessons(doc.file, doc.content)),
    );

    const block = buildInjectBlock({
      globalMemory: readFileSafe(p.globalMemory),
      projectMemory: projectTrusted ? readFileSafe(p.projectMemory) : null,
      today: readFileSafe(dailyFile(p.dailyDir, localDateStr())),
      yesterday: readFileSafe(dailyFile(p.dailyDir, yesterdayStr())),
      dailyDates: listDailyFiles(p).map((f) => f.replace(/\.md$/, "")),
      lessons: lessonsBlock(lessons),
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
      "Set category when the entry is a lesson: failure (something tried that did not work, with the " +
      "error), correction (something the user told you not to repeat), tool-quirk (non-obvious tool " +
      "behaviour), insight, preference, or convention. Categorised failures and corrections are " +
      "recalled at the start of later sessions, so a mistake costs its explanation once. " +
      "Never save credentials — writes are secret-scanned and rejected.",
    parameters: Type.Object({
      scope: StringEnum(["global", "project", "daily"] as const),
      text: Type.String({ description: "One concise entry (a sentence or two)" }),
      category: Type.Optional(StringEnum(LESSON_CATEGORIES)),
    }),
    async execute(
      _id,
      params: { scope: MemoryScope; text: string; category?: LessonCategory },
      _signal,
      _onUpdate,
      ctx,
    ) {
      const text = params.text.trim();
      if (!text) throw new Error("memory_write requires non-empty text.");
      assertNoSecrets(text);
      const body = params.category ? formatLesson(params.category, text) : text;
      const file = appendEntry(requirePaths(ctx as ExtensionContext), params.scope, body);
      return {
        content: [{ type: "text", text: `Saved to ${file}` }],
        details: { file, scope: params.scope, ...(params.category ? { category: params.category } : {}) },
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
    description: "Memory: /memory [search <query> | read <target> | consolidate <target>]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const p = requirePaths(ctx);

      // v0.2: human-facing search/read routes — before this, only the agent
      // could search memory.
      const trimmed = (args ?? "").trim();
      const searchMatch = /^search\s+(.+)$/i.exec(trimmed);
      if (searchMatch) {
        const result = await searchMemory(loadDocs(p), searchMatch[1]!, 8);
        const text =
          result.hits.length === 0
            ? `No matches (${result.engine}).`
            : result.hits.map((h) => `${h.file}:${h.line}\n${h.snippet}`).join("\n\n");
        ctx.ui.notify(`Search (${result.engine})\n${text}`, "info");
        return;
      }
      // v0.3: LLM consolidation — proposes, never writes on its own.
      const consolidateMatch = /^consolidate(?:\s+(\S+))?$/i.exec(trimmed);
      if (consolidateMatch) {
        await runConsolidate(ctx, p, (consolidateMatch[1] ?? "global").toLowerCase());
        return;
      }

      const readMatch = /^read(?:\s+(\S+))?$/i.exec(trimmed);
      if (readMatch) {
        const target = (readMatch[1] ?? "global").toLowerCase();
        if (target === "list") {
          const files = listDailyFiles(p);
          ctx.ui.notify(files.length ? files.join("\n") : "No daily logs yet.", "info");
          return;
        }
        const file =
          target === "global"
            ? p.globalMemory
            : target === "project"
              ? p.projectMemory
              : /^\d{4}-\d{2}-\d{2}$/.test(target)
                ? dailyFile(p.dailyDir, target)
                : null;
        if (!file) {
          ctx.ui.notify("Usage: /memory read <global|project|list|YYYY-MM-DD>", "warning");
          return;
        }
        ctx.ui.notify(readFileSafe(file) ?? `(empty — ${file} does not exist yet)`, "info");
        return;
      }
      if (trimmed) {
        ctx.ui.notify(
          "Usage: /memory [search <query> | read <global|project|list|YYYY-MM-DD> | consolidate <global|project|YYYY-MM-DD>]",
          "warning",
        );
        return;
      }
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
          `  project  ${p.projectMemory} (${sizeOf(p.projectMemory)})` +
            (readConsent(parseConsent(readFileSafe(consentFile())), ctx.cwd, "memory") === true
              ? ""
              : " — NOT injected: you have not approved this project's memory"),
          `  daily    ${dailies.length} log(s) in ${p.dailyDir}`,
          `  search   ${engine}`,
          "Tools: memory_write · memory_read · memory_search · memory_forget · memory_restore",
        ].join("\n"),
        "info",
      );
    },
  });
}
