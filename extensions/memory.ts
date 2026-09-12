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
import { buildInjectBlock, isInjectedInContext } from "../src/inject.ts";
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
import { assertNoSecrets, scanForSecrets } from "../src/secrets.ts";
import {
  OBSERVATION_TYPE,
  OBSERVE_SYSTEM_PROMPT,
  buildObservePrompt,
  charsSinceCoverage,
  countByCategory,
  observeAfterChars,
  dedupeObservations,
  parseObservations,
  renderObservations,
  replayObservations,
  shouldObserve,
  sliceTranscript,
  type Observation,
} from "../src/observe.ts";
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
const OBSERVE_TIMEOUT_MS = 120_000;
/** Entry kinds the observer must not read: its own output and its own block. */
const OBSERVER_BLIND_TO = [MEMORY_CONTEXT_TYPE, OBSERVATION_TYPE];
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
   * This session's answer about the project file, so a re-injection after a
   * compaction never pops a consent dialog in the middle of someone's work.
   * The question is asked at most once per session; the on-disk store keeps
   * it across sessions.
   */
  let projectConsent: boolean | null = null;

  /**
   * May this repository's own memory file be injected? pi never asked about
   * it — `.pi/memory/MEMORY.md` is not one of the resources pi loads — so the
   * question is ours to put, once per project.
   */
  async function projectMemoryAllowed(ctx: ExtensionContext, p: MemoryPaths): Promise<boolean> {
    if (projectConsent !== null) return projectConsent;
    projectConsent = await askProjectMemoryAllowed(ctx, p);
    return projectConsent;
  }

  async function askProjectMemoryAllowed(ctx: ExtensionContext, p: MemoryPaths): Promise<boolean> {
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

  /**
   * The model's answer, from the last assistant message that actually has
   * text in it.
   *
   * Not simply the last assistant message: a thinking model's final message
   * can carry only reasoning blocks, and taking it would yield an empty
   * answer with no error to explain it.
   *
   * Defensive, and honestly so — no measured case yet shows it changing an
   * outcome. It was written while chasing the empty answers from
   * anthropic/claude-opus-5 and it is *not* the cure for those: that model
   * returns no text anywhere in the conversation through this path, scanning
   * backwards or not, while openai/gpt-5.6 and qwen3-235b both answer
   * normally. The empty-answer guard below is what actually makes that
   * visible.
   */
  function answerText(session: AgentSession): string {
    const messages = session.messages as Array<{
      role?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      const text = (message.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim();
      if (text) return text;
    }
    return "";
  }

  /**
   * A resource loader that has actually loaded.
   *
   * `createAgentSession` only calls `reload()` on a loader it creates itself;
   * one passed in is used exactly as handed over, and a freshly constructed
   * `DefaultResourceLoader` has an empty `appendSystemPrompt` until it loads.
   * So a system prompt supplied this way is silently dropped — the call
   * succeeds, the model answers, and it answers without its instructions.
   * Measured: with a loader that appends "begin every reply with BANANA", the
   * reply began with BANANA only after `reload()`.
   */
  async function loadedResourceLoader(cwd: string, systemPrompt: string): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      appendSystemPrompt: [systemPrompt],
    } as never);
    await loader.reload();
    return loader;
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
        resourceLoader: await loadedResourceLoader(ctx.cwd, CONSOLIDATE_SYSTEM_PROMPT),
      });
      session = created.session;
      await session.prompt(buildConsolidatePrompt(target, before), {
        signal: AbortSignal.timeout(CONSOLIDATE_TIMEOUT_MS),
      } as never);
      answer = answerText(session);
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

  // ── Session notes: the observer ──────────────────────────────────────

  /** True while a run is in flight, so turns cannot stack observers. */
  let observing = false;
  /** Why the last run failed, so /memory can say so instead of staying blank. */
  let lastObserveError: string | null = null;
  /** Per-project switch, memoised for the session. */
  let observeEnabled: boolean | null = null;

  function observeAllowed(ctx: ExtensionContext): boolean {
    if (observeEnabled !== null) return observeEnabled;
    const env = envConsent({ PIFY_TRUST_PROJECT: process.env.PIFY_MEMORY_OBSERVE });
    if (env !== undefined) {
      observeEnabled = env;
      return observeEnabled;
    }
    // Off unless this project was switched on. No remembered answer means no.
    observeEnabled = readConsent(parseConsent(readFileSafe(consentFile())), ctx.cwd, "observe") === true;
    return observeEnabled;
  }

  function setObserveAllowed(ctx: ExtensionContext, enabled: boolean): void {
    observeEnabled = enabled;
    const file = consentFile();
    const store = parseConsent(readFileSafe(file));
    try {
      writeFileSync(file, `${JSON.stringify(writeConsent(store, ctx.cwd, "observe", enabled), null, 2)}\n`);
    } catch {
      // An unwritable store costs the memory of the answer, not the answer.
    }
  }

  function currentNotes(ctx: ExtensionContext): { notes: Observation[]; dropped: number } {
    const replayed = replayObservations(ctx.sessionManager.getBranch() as never);
    return { notes: replayed.notes, dropped: replayed.dropped };
  }

  /**
   * Record what this slice of the conversation knew.
   *
   * Runs in the background off `agent_end`: nothing waits for it, and a run
   * that fails leaves the coverage marker where it was so the next one sees a
   * larger slice rather than a hole. Notes go to the branch ledger only —
   * `MEMORY.md` and the daily logs are still written only when asked.
   */
  async function observe(input: {
    cwd: string;
    model: unknown;
    existing: readonly Observation[];
    slice: { text: string; upToId: string | null };
  }): Promise<void> {
    const { cwd, model, existing, slice } = input;
    if (!slice.text.trim() || !slice.upToId) return;

    let session: AgentSession | null = null;
    let answer = "";
    try {
      const created = await createAgentSession({
        sessionManager: SessionManager.inMemory(cwd),
        model: model as never,
        // Note-taking does not need extended thinking, and paying for it on
        // every slice of every session is the wrong default for a background
        // job. (Tried as a fix for the empty answers from claude-opus-5 too;
        // it is not one — that model still returns no text through this path.)
        thinkingLevel: "off",
        // No tools: the observer reads what it is given and writes lines.
        tools: [],
        resourceLoader: await loadedResourceLoader(cwd, OBSERVE_SYSTEM_PROMPT),
      });
      session = created.session;
      await session.prompt(buildObservePrompt(slice.text, existing), {
        signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
      } as never);
      answer = answerText(session);
    } finally {
      try {
        session?.dispose();
      } catch {
        // best-effort
      }
    }

    // An answer of nothing at all is not the same as a considered "NONE".
    // Some models return only reasoning blocks through this path and no text
    // — measured on anthropic/claude-opus-5, which answered 0 characters
    // where openai/gpt-5.6 and qwen3-235b both returned a note. Treating that
    // as deliberate silence would advance coverage over conversation nobody
    // ever read, and the session would quietly take no notes for its whole
    // life with nothing to show why. So it fails loudly and retries later.
    if (!answer.trim()) {
      throw new Error("the observer model returned no text");
    }

    // An observer reads the raw transcript, which is exactly where a pasted
    // key lives. A note is re-injected into every request after a compaction,
    // so a leaked credential would be laundered from one message into all of
    // them. Drop the note, keep the rest, never write the secret anywhere.
    const fresh = dedupeObservations(existing, parseObservations(answer)).filter(
      (note) => scanForSecrets(note.text).length === 0,
    );

    // Coverage advances even when nothing was worth recording: the slice was
    // read, and re-reading it every turn would spend a model call to reach
    // the same silence.
    pi.appendEntry(OBSERVATION_TYPE, { notes: fresh, coversUpToId: slice.upToId });
  }

  pi.on("agent_end", async (_event, ctx) => {
    const uiCtx = ctx as ExtensionContext;
    if (!observeAllowed(uiCtx)) return;
    const branch = uiCtx.sessionManager.getBranch() as never as unknown[];
    const { notes: existing, coversUpToId } = replayObservations(branch);
    if (
      !shouldObserve({
        enabled: true,
        inFlight: observing,
        charsSinceCoverage: charsSinceCoverage(branch, coversUpToId, OBSERVER_BLIND_TO),
        threshold: observeAfterChars(process.env),
      })
    ) {
      return;
    }

    // Everything the run needs is read here, synchronously, and handed over
    // as plain values. A background task must not keep the event's `ctx`:
    // a compaction replaces the session underneath it, and the next property
    // access throws "this extension ctx is stale". Which is exactly what
    // happened — the observer ran, failed on its first ctx read, and left no
    // trace but a silent catch.
    const captured = {
      cwd: uiCtx.cwd,
      model: uiCtx.model,
      existing,
      slice: sliceTranscript(branch, coversUpToId, OBSERVER_BLIND_TO),
    };

    observing = true;
    lastObserveError = null;
    // Not awaited: a turn must never wait on note-taking.
    void observe(captured)
      .catch((err) => {
        lastObserveError = err instanceof Error ? err.message : String(err);
        // A failed run leaves coverage alone; the next one sees more.
      })
      .finally(() => {
        observing = false;
      });
  });

  /**
   * Read the current memory files and render the block, or null when there is
   * nothing to say. Called fresh each time rather than caching the rendered
   * text: a `memory_write` earlier in the session should be part of what
   * survives the compaction that follows it.
   */
  async function currentBlock(
    ctx: ExtensionContext,
    p: MemoryPaths,
    options: { withNotes?: boolean } = {},
  ): Promise<string | null> {
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

    return buildInjectBlock({
      globalMemory: readFileSafe(p.globalMemory),
      projectMemory: projectTrusted ? readFileSafe(p.projectMemory) : null,
      today: readFileSafe(dailyFile(p.dailyDir, localDateStr())),
      yesterday: readFileSafe(dailyFile(p.dailyDir, yesterdayStr())),
      dailyDates: listDailyFiles(p).map((f) => f.replace(/\.md$/, "")),
      lessons: lessonsBlock(lessons),
      // Notes are the part that earns its tokens only once the conversation
      // they describe has been folded away. Before that the transcript is
      // still right there and including them would say everything twice.
      notes: options.withNotes
        ? (() => {
            const { notes, dropped } = currentNotes(ctx);
            return renderObservations(notes, dropped);
          })()
        : null,
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const p = requirePaths(ctx);
    ensureDirs(p);

    // Dedupe across /reload and resume — against the entries the model can
    // actually see, not the raw branch. Those two lists diverge the moment a
    // compaction happens: the folded block stays on the branch forever while
    // disappearing from the conversation, and checking the branch would let a
    // resumed session start with no memory and believe it had some.
    if (isInjectedInContext(ctx.sessionManager.buildContextEntries(), MEMORY_CONTEXT_TYPE)) return;

    // A resumed session may already carry notes from before a compaction, so
    // they come along here too. At session start this costs no cache: the
    // block is injected once, before anything is cached.
    const block = await currentBlock(ctx, p, { withNotes: true });
    if (block) {
      pi.sendMessage({ customType: MEMORY_CONTEXT_TYPE, content: block, display: false });
    }
  });

  /**
   * Compaction keeps the most recent `keepRecentTokens` and folds everything
   * older into a summary. The memory block is injected once before the first
   * prompt, which makes it the oldest entry in the session and guaranteed to
   * be in the folded region — so without this, memory lasts until the first
   * compaction and then quietly goes missing for the rest of the session.
   *
   * Re-attaching it is deliberately the whole fix. No model is called here:
   * this package's promise is that memory is never rewritten by a surprise
   * summarisation, and a compaction is exactly the moment that promise is
   * most tempting to break. pi's own summariser still writes the summary; we
   * only put the user's own bytes back in front of it.
   */
  pi.on("session_compact", async (_event, ctx) => {
    const p = requirePaths(ctx as ExtensionContext);
    if (isInjectedInContext(ctx.sessionManager.buildContextEntries(), MEMORY_CONTEXT_TYPE)) return;
    const block = await currentBlock(ctx as ExtensionContext, p, { withNotes: true });
    if (block) {
      pi.sendMessage({ customType: MEMORY_CONTEXT_TYPE, content: block, display: false });
    }
  });

  // ── Tools ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_write",
    label: "Memory write",
    promptSnippet: "Save one durable fact, project convention, or dated log entry",
    promptGuidelines: [
      "Use memory_write when the user asks you to remember something, or corrects you in a way that should still be true next session; a correction you do not save is one you will repeat.",
    ],
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
    promptSnippet: "Read a memory file, or list the daily logs",
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
    promptSnippet: "Full-text search across every memory file",
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
    promptSnippet: "Delete matching memory entries, keeping a recovery record",
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
    promptSnippet: "Undo a memory_forget by its recovery id",
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
    description: "Memory: /memory [search <query> | read <target> | consolidate <target> | restore <id> | notes | observe on|off]",
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

      // v0.8: session notes.
      const observeMatch = /^observe(?:\s+(on|off))?$/i.exec(trimmed);
      if (observeMatch) {
        const arg = observeMatch[1]?.toLowerCase();
        if (arg === "on" || arg === "off") {
          setObserveAllowed(ctx, arg === "on");
          ctx.ui.notify(
            arg === "on"
              ? "Session notes ON for this project. A background model call reads each new stretch of the conversation and records what would be expensive to rediscover. Notes go to this session only — your memory files are never written without you."
              : "Session notes OFF for this project.",
            "info",
          );
          return;
        }
        ctx.ui.notify(
          `Session notes are ${observeAllowed(ctx) ? "ON" : "OFF"} for this project. Use /memory observe on|off.`,
          "info",
        );
        return;
      }
      if (/^notes$/i.test(trimmed)) {
        const { notes, dropped } = currentNotes(ctx);
        ctx.ui.notify(
          notes.length === 0
            ? observeAllowed(ctx)
              ? "No session notes yet. They are recorded in the background as the conversation grows."
              : "Session notes are off for this project. Turn them on with /memory observe on."
            : [
                `${notes.length} session note(s) — kept past compaction, never written to your files:` +
                  (dropped > 0 ? ` (${dropped} older dropped at the cap)` : ""),
                ...notes.map((n) => `  [${n.category}] ${n.text}`),
              ].join("\n"),
          "info",
        );
        return;
      }

      // The undo path this package's own notices advertise. The tool existed;
      // the command route it pointed at did not — "/memory restore <id>" fell
      // through to the usage warning and restored nothing, which for an undo
      // is the worst possible answer at the worst possible moment.
      const restoreMatch = /^restore\s+(\S+)$/i.exec(trimmed);
      if (restoreMatch) {
        try {
          const restored = restore(p, restoreMatch[1]!.trim());
          ctx.ui.notify(
            restored > 0
              ? `Restored ${restored} entr${restored > 1 ? "ies" : "y"}.`
              : `Nothing restored — no recovery record named "${restoreMatch[1]}".`,
            restored > 0 ? "info" : "warning",
          );
        } catch (err) {
          ctx.ui.notify(`Restore failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
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
          "Usage: /memory [search <query> | read <global|project|list|YYYY-MM-DD> | consolidate <global|project|YYYY-MM-DD> | restore <id> | notes | observe on|off]",
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
          `  notes    ${
            observeAllowed(ctx)
              ? (() => {
                  const { notes } = currentNotes(ctx);
                  const mix = countByCategory(notes)
                    .map(([category, n]) => `${n} ${category}`)
                    .join(", ");
                  return `on — ${notes.length} this session${mix ? ` (${mix})` : ""}`;
                })()
              : "off — /memory observe on"
          }${lastObserveError ? "\n           last run failed: " + lastObserveError : ""}`,
          "Tools: memory_write · memory_read · memory_search · memory_forget · memory_restore",
        ].join("\n"),
        "info",
      );
    },
  });
}
