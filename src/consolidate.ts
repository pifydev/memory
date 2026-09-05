/**
 * LLM consolidation (samfoy's "corrections stick"): memory files accumulate
 * near-duplicates and facts that a later entry already contradicts. A model
 * is good at merging those; it is also good at quietly inventing a fact that
 * was never there. So the model only ever proposes — everything here decides
 * whether the proposal is safe enough to show, and the write itself needs the
 * user's confirmation and leaves a recovery record.
 *
 * Pure functions only: prompt building, extraction, and the safety
 * assessment, all testable without an LLM.
 */

export const CONSOLIDATE_SYSTEM_PROMPT = [
  "You consolidate a markdown memory file. You are editing a record of facts, not writing prose.",
  "Rules, in order of priority:",
  "(1) Never invent a fact that is not in the input.",
  "(2) When two entries conflict, keep the LATER one — entries are in chronological order and later entries are corrections.",
  "(3) Merge duplicates and near-duplicates into one entry, keeping the most specific wording.",
  "(4) Keep every fact that is not a duplicate or a superseded correction, in its original wording where possible.",
  "(5) Keep the file's heading structure and its bullet-list format.",
  "Output ONLY the consolidated markdown inside one ```markdown fenced block. No commentary.",
].join(" ");

export function buildConsolidatePrompt(label: string, content: string): string {
  return [
    `Consolidate this memory file (${label}).`,
    "",
    "```markdown",
    content.trim(),
    "```",
    "",
    "Return the consolidated file in one ```markdown block.",
  ].join("\n");
}

/** Pull the markdown out of the answer; tolerate a missing fence. */
export function parseConsolidation(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const fenced = /```(?:markdown|md)?\s*\n([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced ? fenced[1]! : trimmed).trim();
  if (!body) return null;
  // Without a fence, only accept something that still looks like the file.
  if (!fenced && !/^[#-]/m.test(body)) return null;
  return body;
}

export function bulletsOf(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-") || line.startsWith("*"));
}

/** Normalized bullet text, for comparing entries across a rewrite. */
function normalizeBullet(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/^\d{1,2}:\d{2}\s+/, "") // daily entries carry a time prefix
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface ConsolidationAssessment {
  ok: boolean;
  /** Why the proposal was refused, when it was. */
  reason: string | null;
  keptCount: number;
  removedCount: number;
  /** Bullets in the proposal that match nothing in the original. */
  invented: string[];
}

/** A consolidation that drops more than this share of entries is suspect. */
export const MAX_REMOVAL_RATIO = 0.6;

/**
 * Decide whether a proposed rewrite is safe to offer. Consolidation is
 * supposed to shrink a file, so shrinking is not by itself a problem — but a
 * proposal that drops most of the file, empties it, or contains entries that
 * appear nowhere in the original is a model failure, not a consolidation.
 */
export function assessConsolidation(before: string, after: string): ConsolidationAssessment {
  const originals = bulletsOf(before).map(normalizeBullet);
  const proposed = bulletsOf(after).map(normalizeBullet);

  if (proposed.length === 0) {
    return {
      ok: false,
      reason: "the proposal has no entries left",
      keptCount: 0,
      removedCount: originals.length,
      invented: [],
    };
  }

  // An entry counts as preserved if some original contains it or it contains
  // an original — merged entries legitimately absorb their neighbours.
  const invented = bulletsOf(after).filter((line) => {
    const norm = normalizeBullet(line);
    if (!norm) return false;
    return !originals.some((orig) => orig.includes(norm) || norm.includes(orig));
  });

  const removedCount = Math.max(0, originals.length - proposed.length);
  const ratio = originals.length === 0 ? 0 : removedCount / originals.length;
  if (ratio > MAX_REMOVAL_RATIO) {
    return {
      ok: false,
      reason: `it drops ${removedCount} of ${originals.length} entries (over ${Math.round(MAX_REMOVAL_RATIO * 100)}%)`,
      keptCount: proposed.length,
      removedCount,
      invented,
    };
  }
  if (invented.length > 0) {
    return {
      ok: false,
      reason: `${invented.length} entr${invented.length === 1 ? "y" : "ies"} appear nowhere in the original`,
      keptCount: proposed.length,
      removedCount,
      invented,
    };
  }

  return { ok: true, reason: null, keptCount: proposed.length, removedCount, invented: [] };
}

const PREVIEW_LINES = 8;

/** Human-readable summary of what the consolidation would change. */
export function consolidationPreview(before: string, after: string): string {
  const originals = bulletsOf(before);
  const proposed = new Set(bulletsOf(after).map(normalizeBullet));
  const dropped = originals.filter((line) => {
    const norm = normalizeBullet(line);
    return ![...proposed].some((p) => p.includes(norm) || norm.includes(p));
  });

  const lines = [
    `${originals.length} entries → ${bulletsOf(after).length}`,
    `${before.length} chars → ${after.length}`,
  ];
  if (dropped.length > 0) {
    lines.push("Folded in or dropped:");
    for (const line of dropped.slice(0, PREVIEW_LINES)) {
      lines.push(`  ${line.length > 90 ? `${line.slice(0, 89)}…` : line}`);
    }
    if (dropped.length > PREVIEW_LINES) lines.push(`  … +${dropped.length - PREVIEW_LINES} more`);
  }
  return lines.join("\n");
}
