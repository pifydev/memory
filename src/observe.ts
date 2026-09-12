/**
 * Session notes: what the conversation itself knew, kept past the fold.
 *
 * The idea is elpapi42/pi-observational-memory's. A long session compacts,
 * and pi's summariser is a general-purpose one: it keeps the shape of the
 * work and loses the things that are expensive to rediscover — the approach
 * that was tried and abandoned, the correction, the constraint someone stated
 * once in passing. Compact twice and the agent is working from a summary of a
 * summary.
 *
 * The port is deliberately narrow, because this package already made two
 * promises that a naive observer would break.
 *
 * **It never writes to your files.** Notes are branch-local ledger entries.
 * They live and die with the session. `MEMORY.md` and the daily logs are
 * still written only when you ask or when the agent records a lesson through
 * `memory_write`. An observer that quietly edited durable memory would be the
 * black box this package exists not to be; one that keeps session notes is
 * just remembering what was already said out loud.
 *
 * **It never runs behind your back.** Off unless turned on per project, and
 * turning it on is the sanction.
 *
 * And it adds a gate the upstream design does not need but this one does: an
 * observer reads the raw transcript, which is exactly where credentials get
 * pasted. Every note is secret-scanned before it is recorded, because a note
 * is re-injected into every request after a compaction.
 *
 * Pure functions only — the model call lives in the extension.
 */

import { LESSON_CATEGORIES, isLessonCategory, type LessonCategory } from "./lessons.ts";

export const OBSERVATION_TYPE = "memory-observation";

/**
 * How much new conversation is worth a model call. Roughly six thousand
 * tokens: small enough that a long session gets observed several times,
 * large enough that a short exchange never triggers one.
 */
export const OBSERVE_AFTER_CHARS = 24_000;

/**
 * The default, or `PIFY_MEMORY_OBSERVE_AFTER_CHARS` when it is a sane number.
 * Cadence is a taste question — a dense session may be worth observing more
 * often, a rambling one less — and nonsense in the variable falls back rather
 * than disabling note-taking or spending a model call every turn.
 */
export function observeAfterChars(env: Record<string, string | undefined>): number {
  const raw = Number(env.PIFY_MEMORY_OBSERVE_AFTER_CHARS);
  if (!Number.isFinite(raw) || raw < 500) return OBSERVE_AFTER_CHARS;
  return Math.floor(raw);
}

/** A note is one line. Anything longer is a summary, which is not the job. */
export const MAX_NOTE_CHARS = 240;
export const MAX_NOTES_PER_RUN = 6;
/** Total notes carried into a compaction, newest kept. */
export const MAX_NOTES_KEPT = 40;
/** How much transcript goes to the observer in one run. */
export const MAX_TRANSCRIPT_CHARS = 60_000;

export interface Observation {
  category: LessonCategory;
  text: string;
}

export interface ObservationEntry {
  notes: Observation[];
  /** Branch entry this run had read up to, so the next run starts after it. */
  coversUpToId: string;
}

/**
 * The format instruction is the load-bearing part, and it is repeated with an
 * example on purpose. Asked to "output `[category] text`" in a single trailing
 * sentence, the model found the right fact and wrote `NOTES: Every install
 * must pass …` — a correct observation in a shape nothing downstream could
 * read. Measured on openrouter/qwen3-235b: prose prefix without the worked
 * example, parsed cleanly with it.
 */
export const OBSERVE_SYSTEM_PROMPT = [
  "You read a slice of a coding session and record what would be expensive to rediscover if this",
  "part of the conversation were summarised away. You are taking notes, not writing a summary.",
  "",
  "Record only these kinds of thing:",
  "[failure] something tried that did not work, and why",
  "[correction] the user correcting an assumption, an approach, or a fact",
  "[insight] a non-obvious conclusion reached, or an approach deliberately rejected",
  "[preference] how the user wants things done",
  "[convention] a rule this project follows",
  "[tool-quirk] a tool or command that does not behave as documented",
  "",
  "Never invent anything that is not in the text. Do not record routine progress, file listings,",
  "or what a command printed. Do not record anything that would be obvious from reading the code.",
  "Never include credentials, tokens, or keys even if they appear in the text.",
  "Write each note so it still makes sense with no other context.",
  "",
  "OUTPUT FORMAT — this is strict. One note per line, each line starting with the category in",
  "square brackets and nothing before it. No preamble, no heading, no `NOTES:` prefix, no bullets,",
  "no blank lines, no commentary, no code fence. The shape is:",
  "",
  "[convention] <one sentence, in your own words, about the session you just read>",
  "[failure] <one sentence, in your own words, about the session you just read>",
  "",
  // The example is a shape, not a sentence, on purpose. An earlier version
  // showed two fully written notes — one of them about a lockfile flag — and
  // the model recorded the *example's* flag instead of the one actually
  // stated in the transcript. A worked example that resembles the input is an
  // invitation to copy it, and a memory that records the prompt's own
  // furniture is worse than one that records nothing.
  "Every note must come from the text above. Never copy wording from this instruction.",
  "If there is genuinely nothing worth recording, output the single word NONE and nothing else.",
].join("\n");

export function buildObservePrompt(transcript: string, existing: readonly Observation[]): string {
  const already =
    existing.length > 0
      ? [
          "",
          "Already recorded earlier in this session — do not repeat these:",
          ...existing.slice(-MAX_NOTES_KEPT).map((n) => `[${n.category}] ${n.text}`),
        ].join("\n")
      : "";
  return [
    "Here is the next part of the session.",
    "",
    transcript.trim(),
    already,
    "",
    "Record the notes worth keeping, or NONE.",
  ].join("\n");
}

/**
 * Read `[category] text` lines out of the answer.
 *
 * Deliberately strict about the category and forgiving about everything else:
 * a model that wraps the list in a fence or adds a stray bullet should still
 * have its notes read, while a line that invents a category is dropped rather
 * than coerced into the nearest one.
 */
export function parseObservations(text: string): Observation[] {
  const body = (text ?? "").trim();
  if (!body) return [];
  const out: Observation[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim().replace(/^```\w*$/, "").replace(/^[-*]\s*/, "").trim();
    if (!line || line.toUpperCase() === "NONE") continue;
    const match = /^\[([a-z-]+)\]\s*(.+)$/i.exec(line);
    if (!match) continue;
    const category = match[1]!.toLowerCase();
    if (!isLessonCategory(category)) continue;
    const noteText = match[2]!.trim().slice(0, MAX_NOTE_CHARS);
    if (!noteText) continue;
    out.push({ category, text: noteText });
    if (out.length >= MAX_NOTES_PER_RUN) break;
  }
  return out;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Drop notes the session already has. Observers re-read overlapping ground
 * and restate the same conclusion in slightly different words; without this
 * the note list grows while saying the same few things.
 */
export function dedupeObservations(
  existing: readonly Observation[],
  incoming: readonly Observation[],
): Observation[] {
  const seen = new Set(existing.map((n) => normalize(n.text)));
  const out: Observation[] = [];
  for (const note of incoming) {
    const key = normalize(note.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(note);
  }
  return out;
}

/** Is there enough new conversation to be worth a model call? */
export function shouldObserve(input: {
  enabled: boolean;
  inFlight: boolean;
  charsSinceCoverage: number;
  threshold?: number;
}): boolean {
  if (!input.enabled || input.inFlight) return false;
  return input.charsSinceCoverage >= (input.threshold ?? OBSERVE_AFTER_CHARS);
}

interface BranchEntryLike {
  id?: string;
  customType?: string;
  data?: unknown;
}

/**
 * Fold the branch's observation entries into one list, newest last, and say
 * where the last run had read up to.
 *
 * Tolerant by construction: an entry written by a different version, or
 * half-written, is skipped rather than throwing. A ledger that can crash the
 * session start is worse than one that forgets.
 */
export function replayObservations(branch: readonly unknown[]): {
  notes: Observation[];
  coversUpToId: string | null;
} {
  const notes: Observation[] = [];
  let coversUpToId: string | null = null;
  for (const raw of branch) {
    const entry = raw as BranchEntryLike | null;
    if (!entry || entry.customType !== OBSERVATION_TYPE) continue;
    const data = entry.data as { notes?: unknown; coversUpToId?: unknown } | undefined;
    if (!data) continue;
    if (typeof data.coversUpToId === "string" && data.coversUpToId) coversUpToId = data.coversUpToId;
    if (!Array.isArray(data.notes)) continue;
    for (const item of data.notes) {
      const note = item as { category?: unknown; text?: unknown };
      if (!isLessonCategory(note?.category)) continue;
      if (typeof note.text !== "string" || !note.text.trim()) continue;
      notes.push({ category: note.category, text: note.text.slice(0, MAX_NOTE_CHARS) });
    }
  }
  // Keep the newest when a very long session has accumulated more than the cap.
  return { notes: notes.slice(-MAX_NOTES_KEPT), coversUpToId };
}

/**
 * Serialize the branch entries after `coversUpToId` into something an
 * observer can read, and say which entry it read up to.
 *
 * Only real conversation goes in — this package's own memory block and its
 * own note entries are excluded. Feeding the observer its own output is how a
 * note list starts restating itself with growing confidence and no new
 * evidence behind it.
 *
 * The slice is capped and taken from the OLDEST uncovered entry forward, so a
 * session that outruns the observer drains in order instead of skipping the
 * middle. Coverage advances only over what was actually read.
 */
export function sliceTranscript(
  branch: readonly unknown[],
  coversUpToId: string | null,
  excludeCustomTypes: readonly string[],
): { text: string; upToId: string | null; chars: number } {
  const entries = branch as Array<Record<string, unknown>>;
  let start = 0;
  if (coversUpToId) {
    const at = entries.findIndex((e) => e?.id === coversUpToId);
    if (at >= 0) start = at + 1;
  }

  const parts: string[] = [];
  let chars = 0;
  let upToId: string | null = null;
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i]!;
    const customType = entry.customType as string | undefined;
    if (customType && excludeCustomTypes.includes(customType)) {
      // Still counts as covered: skipping it must not make the next run
      // re-examine it forever.
      upToId = (entry.id as string) ?? upToId;
      continue;
    }
    const text = entryText(entry);
    if (!text) {
      upToId = (entry.id as string) ?? upToId;
      continue;
    }
    if (chars + text.length > MAX_TRANSCRIPT_CHARS && parts.length > 0) break;
    parts.push(text);
    chars += text.length;
    upToId = (entry.id as string) ?? upToId;
  }
  return { text: parts.join("\n\n"), upToId, chars };
}

/**
 * Plain `role: text` for one entry, or null when it carries no text.
 *
 * The role is whatever the entry can offer, because entries reach the branch
 * by more than one route: a plain message has `message.role`, while anything
 * an extension sent is a `custom_message` that may or may not carry a
 * `customType`. Requiring a role meant every such entry was silently read as
 * empty — which made the observer's own trigger think nothing had been said.
 */
function entryText(entry: Record<string, unknown>): string | null {
  const message = entry.message as { role?: string; content?: unknown } | undefined;
  const role =
    (typeof message?.role === "string" && message.role) ||
    (typeof entry.customType === "string" && entry.customType) ||
    (typeof entry.type === "string" && entry.type) ||
    "context";
  const content = message?.content ?? entry.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((block) => {
        const b = block as { type?: string; text?: string };
        return b?.type === "text" && typeof b.text === "string" ? b.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  text = text.trim();
  if (!text) return null;
  return `${role}: ${text}`;
}

/** How much unobserved conversation is on the branch right now. */
export function charsSinceCoverage(
  branch: readonly unknown[],
  coversUpToId: string | null,
  excludeCustomTypes: readonly string[],
): number {
  return sliceTranscript(branch, coversUpToId, excludeCustomTypes).chars;
}

/** The section that rides along with the memory block. */
export function renderObservations(notes: readonly Observation[]): string | null {
  if (notes.length === 0) return null;
  return [
    "## Notes from earlier in this session",
    "Recorded as the conversation happened, before it was summarised. Verbatim, not re-summarised.",
    ...notes.map((n) => `- [${n.category}] ${n.text}`),
  ].join("\n");
}

/** Category order for a status line, so `/memory` can report the mix. */
export function countByCategory(notes: readonly Observation[]): Array<[LessonCategory, number]> {
  return LESSON_CATEGORIES.map(
    (category) => [category, notes.filter((n) => n.category === category).length] as [LessonCategory, number],
  ).filter(([, n]) => n > 0);
}
