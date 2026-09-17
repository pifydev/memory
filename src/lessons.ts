/**
 * Categorised lessons (chandra447/pi-hermes-memory's vocabulary).
 *
 * Everything in this store is a bullet, which makes every entry equally
 * findable and equally forgettable. The entries that pay for themselves are
 * the ones that stop a repeat: what was already tried and failed, what the
 * user corrected, the tool that does not behave the way its docs say. Those
 * deserve to be recognisable — at write time, at search time, and at the top
 * of the next session.
 *
 * The tag rides in the bullet text (`- [failure] …`) rather than in a
 * sidecar index, because the promise of this package is that the files stay
 * plain markdown you can read, edit, and commit.
 */

export const LESSON_CATEGORIES = [
  "failure",
  "correction",
  "insight",
  "preference",
  "convention",
  "tool-quirk",
] as const;

export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

/** Categories worth surfacing unprompted: they exist to prevent a repeat. */
export const RECALLED_CATEGORIES: readonly LessonCategory[] = ["failure", "correction"];

export function isLessonCategory(value: unknown): value is LessonCategory {
  return typeof value === "string" && (LESSON_CATEGORIES as readonly string[]).includes(value);
}

/** `- [failure] the text` — the stored form. */
export function formatLesson(category: LessonCategory, text: string): string {
  return `[${category}] ${text.trim()}`;
}

export interface Lesson {
  category: LessonCategory;
  text: string;
  /** Source file, for reporting where a recalled lesson came from. */
  file: string;
  /** Local date parsed from a daily filename, when the entry came from one. */
  date: string | null;
}

const BULLET = /^\s*[-*]\s+(?:(\d{1,2}:\d{2})\s+)?\[([a-z-]+)\]\s*(.+?)\s*$/;
const DAILY_DATE = /(\d{4}-\d{2}-\d{2})\.md$/;

/** Read every categorised entry out of one memory file. */
export function extractLessons(file: string, content: string): Lesson[] {
  const date = DAILY_DATE.exec(file.replace(/\\/g, "/"))?.[1] ?? null;
  const lessons: Lesson[] = [];
  for (const line of content.split("\n")) {
    const match = BULLET.exec(line);
    if (!match) continue;
    const category = match[2]!;
    if (!isLessonCategory(category)) continue;
    const text = match[3]!.trim();
    if (text) lessons.push({ category, text, file, date });
  }
  return lessons;
}

export interface RecallOptions {
  categories?: readonly LessonCategory[];
  /** Newest N kept; older entries are dropped rather than summarised. */
  limit?: number;
  /** Daily entries older than this are dropped. Undated entries always pass. */
  maxAgeDays?: number;
  today?: Date;
}

export const DEFAULT_RECALL_LIMIT = 8;
export const DEFAULT_RECALL_MAX_AGE_DAYS = 30;

function daysBetween(from: string, today: Date): number {
  const parsed = Date.parse(`${from}T00:00:00`);
  if (Number.isNaN(parsed)) return 0;
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((start - parsed) / 86_400_000);
}

/**
 * The lessons worth putting in front of the next session: newest first,
 * bounded by age and count. A lesson from a year ago about a file that no
 * longer exists costs context and credibility, which is why the window
 * exists at all.
 *
 * "Newest first" has to be defined for the two kinds of lesson we hold. Dated
 * lessons come from `daily/YYYY-MM-DD.md`; undated ones from `MEMORY.md`, which
 * carries no date at all. The old sort gave every undated lesson the same
 * sentinel key, so eight of them always outranked every dated one AND — because
 * a stable sort kept them in append (oldest-first) order — the eight recalled
 * were the OLDEST undated lessons, i.e. exactly not the correction you just
 * made. The README promised the opposite.
 *
 * The order this returns: dated lessons (all within `maxAge` after the filter)
 * newest-first, ahead of undated lessons — a lesson we can date to this window
 * is demonstrably newer than an undated one of unknown age. Reversing the input
 * first (it arrives in file/append order, oldest first) makes the undated group
 * last-written-first and breaks same-day dated ties toward later-in-the-day.
 */
export function recallLessons(lessons: readonly Lesson[], opts: RecallOptions = {}): Lesson[] {
  const categories = new Set(opts.categories ?? RECALLED_CATEGORIES);
  const limit = opts.limit ?? DEFAULT_RECALL_LIMIT;
  const maxAge = opts.maxAgeDays ?? DEFAULT_RECALL_MAX_AGE_DAYS;
  const today = opts.today ?? new Date();

  return [...lessons]
    .reverse()
    .filter((lesson) => categories.has(lesson.category))
    .filter((lesson) => (lesson.date ? daysBetween(lesson.date, today) <= maxAge : true))
    .sort((a, b) => {
      // Dated ahead of undated; among dated, newest first. Same-date and
      // both-undated comparisons return 0, so the stable sort keeps the
      // reversed (last-written-first) order for those.
      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;
      if (a.date && b.date) return b.date.localeCompare(a.date);
      return 0;
    })
    .slice(0, Math.max(0, limit));
}

/** The injected block; null when there is nothing worth recalling. */
export function lessonsBlock(lessons: readonly Lesson[]): string | null {
  if (lessons.length === 0) return null;
  const lines = lessons.map((lesson) => `- [${lesson.category}] ${lesson.text}`);
  return [
    "## Lessons that should not be repeated",
    ...lines,
    "Check these before retrying something that failed before.",
  ].join("\n");
}
