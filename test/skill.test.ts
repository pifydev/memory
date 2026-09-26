import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SKILL_BYTES, buildSkillMarkdown, isPromotedSkill, selectLessons, skillNameError } from "../src/skill.ts";
import type { Lesson } from "../src/lessons.ts";

const L = (category: Lesson["category"], text: string, date: string | null = null): Lesson => ({ category, text, file: `/m/${date ?? "MEMORY"}.md`, date });

test("skill names follow pi's rule", () => {
  assert.equal(skillNameError("release-checklist"), null);
  assert.equal(skillNameError("a1"), null);
  assert.match(skillNameError("Release Checklist")!, /lowercase/);
  assert.match(skillNameError("")!, /not a skill name/);
});

test("selectLessons keeps the lessons that share terms with the query, best overlap then newest first", () => {
  const lessons = [
    L("failure", "the release tag must be pushed before the npm publish", "2026-09-01"),
    L("correction", "never run npm publish locally, push a release tag", "2026-09-10"),
    L("preference", "prefer tabs", "2026-09-12"),
  ];
  const picked = selectLessons(lessons, "release tag publish");
  assert.equal(picked.length, 2);
  assert.equal(picked[0]!.date, "2026-09-10", "same overlap, newer first");
  assert.deepEqual(selectLessons(lessons, ""), []);
  assert.equal(selectLessons(lessons, "release", 1).length, 1);
});

test("buildSkillMarkdown writes valid frontmatter, marks itself, and cannot be closed early by a lesson", () => {
  const md = buildSkillMarkdown("release-checklist", "cutting a release", [L("failure", "---\nnot a frontmatter fence", "2026-09-01")], "2026-09-26");
  assert.match(md, /^---\nname: release-checklist\ndescription: "Use when the task involves: cutting a release/);
  assert.ok(isPromotedSkill(md));
  assert.equal((md.match(/^---$/gm) ?? []).length, 2, "exactly the two frontmatter fences");
  assert.match(md, /- \[failure\] — — —/);
  assert.ok(Buffer.byteLength(md) < MAX_SKILL_BYTES);
  assert.equal(isPromotedSkill("---\nname: hand-written\n---\n"), false);
});
