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
 */
export function recallLessons(lessons: readonly Lesson[], opts: RecallOptions = {}): Lesson[] {
  const categories = new Set(opts.categories ?? RECALLED_CATEGORIES);
  const limit = opts.limit ?? DEFAULT_RECALL_LIMIT;
  const maxAge = opts.maxAgeDays ?? DEFAULT_RECALL_MAX_AGE_DAYS;
  const today = opts.today ?? new Date();

  return lessons
    .filter((lesson) => categories.has(lesson.category))
    .filter((lesson) => (lesson.date ? daysBetween(lesson.date, today) <= maxAge : true))
    .sort((a, b) => (b.date ?? "9999-99-99").localeCompare(a.date ?? "9999-99-99"))
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
