/**
 * Promoting lessons into a skill.
 *
 * A lesson is a flat bullet in a memory file: recalled when it matches, and
 * otherwise inert. A procedure that keeps coming up deserves to be a pi
 * skill instead — discoverable by name, loaded on demand, with the same
 * words every time. This builds the SKILL.md from the lessons that match a
 * query; the extension previews it, asks, writes it under the user's own
 * skills directory, and reloads. Only the user can trigger it. Pure.
 *
 * (oh-my-pi's learn → manage_skill promotion, without the agent-driven half.)
 */
import type { Lesson } from "./lessons.ts";
/** Lowercase word terms of 2+ chars; the same shape recall uses, kept local so this module stays dependency-free. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_][a-z0-9_.-]*[a-z0-9_]|[a-z0-9_]{2,}/g) ?? []).filter((t) => t.length >= 2);
}
export function queryTerms(query: string): string[] {
  return [...new Set(tokenize(query))];
}

export const SKILL_MARKER = 'generated-by: "@pify/memory"';
export const MAX_SKILL_BYTES = 64 * 1024;
export const DEFAULT_SKILL_LESSONS = 12;

/** Why a name cannot be a skill name, or null when it can. pi's own rule: lowercase, digits, hyphens. */
export function skillNameError(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
    return `"${name}" is not a skill name: use lowercase letters, digits and hyphens (e.g. release-checklist).`;
  }
  return null;
}

/** The lessons that share terms with the query, best overlap first, newest first on ties. */
export function selectLessons(lessons: readonly Lesson[], query: string, limit: number = DEFAULT_SKILL_LESSONS): Lesson[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored = lessons
    .map((lesson, index) => {
      const have = new Set(tokenize(`${lesson.category} ${lesson.text}`));
      let matched = 0;
      for (const t of terms) if (have.has(t)) matched++;
      return { lesson, matched, index };
    })
    .filter((s) => s.matched > 0);
  scored.sort((a, b) => b.matched - a.matched || (b.lesson.date ?? "").localeCompare(a.lesson.date ?? "") || b.index - a.index);
  return scored.slice(0, limit).map((s) => s.lesson);
}

function neutralize(text: string): string {
  // Frontmatter is the only structure; a lesson must not be able to close it early.
  return text.replace(/^---\s*$/gm, "— — —");
}

/** The SKILL.md text. Deterministic for the same inputs. */
export function buildSkillMarkdown(name: string, query: string, lessons: readonly Lesson[], today: string): string {
  const description = `Use when the task involves: ${query.trim()}. Lessons promoted from memory.`.replace(/\s+/g, " ").slice(0, 240);
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${JSON.stringify(description)}`,
    SKILL_MARKER,
    `promoted: ${today}`,
    "---",
    "",
    `# ${name}`,
    "",
    `Lessons promoted from memory on ${today} for: ${neutralize(query.trim())}. Each one was recorded after it cost something; treat them as rules, not suggestions.`,
    "",
    "## Lessons",
    "",
  ];
  for (const l of lessons) {
    const where = [l.date, l.file.replace(/\\/g, "/").split("/").pop()].filter(Boolean).join(", ");
    lines.push(`- [${l.category}] ${neutralize(l.text)}${where ? ` _(${where})_` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** True when an existing SKILL.md was written by this promotion path and may be replaced. */
export function isPromotedSkill(content: string): boolean {
  return content.includes(SKILL_MARKER);
}
