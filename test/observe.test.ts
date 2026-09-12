import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NOTES_PER_RUN,
  MAX_NOTE_CHARS,
  OBSERVATION_TYPE,
  OBSERVE_AFTER_CHARS,
  charsSinceCoverage,
  countByCategory,
  dedupeObservations,
  parseObservations,
  renderObservations,
  replayObservations,
  shouldObserve,
  sliceTranscript,
} from "../src/observe.ts";
import { scanForSecrets } from "../src/secrets.ts";

const msg = (id: string, parentId: string | null, role: string, text: string) => ({
  id,
  parentId,
  type: "message",
  message: { role, content: [{ type: "text", text }] },
});

const note = (id: string, parentId: string | null, notes: unknown[], coversUpToId: string) => ({
  id,
  parentId,
  type: "custom_message",
  customType: OBSERVATION_TYPE,
  data: { notes, coversUpToId },
});

test("only well-formed notes with a real category are read", () => {
  const parsed = parseObservations(
    [
      "[failure] npm ci fails behind the proxy",
      "- [correction] the user wants tabs, not spaces",
      "[nonsense] invented category",
      "no brackets at all",
      "[insight] the retry loop masks the real error",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.map((n) => `${n.category}:${n.text}`),
    [
      "failure:npm ci fails behind the proxy",
      "correction:the user wants tabs, not spaces",
      "insight:the retry loop masks the real error",
    ],
  );
});

test("NONE and fences mean nothing was recorded", () => {
  assert.deepEqual(parseObservations("NONE"), []);
  assert.deepEqual(parseObservations("```\nNONE\n```"), []);
  assert.deepEqual(parseObservations(""), []);
  assert.deepEqual(parseObservations("   "), []);
});

test("a note is one line, and a run is bounded", () => {
  const long = parseObservations(`[insight] ${"x".repeat(500)}`);
  assert.equal(long[0]!.text.length, MAX_NOTE_CHARS);
  const many = parseObservations(
    Array.from({ length: 20 }, (_, i) => `[insight] note number ${i}`).join("\n"),
  );
  assert.equal(many.length, MAX_NOTES_PER_RUN);
});

test("restating a note in different words does not add it twice", () => {
  const existing = [{ category: "failure" as const, text: "npm ci fails behind the proxy" }];
  const fresh = dedupeObservations(existing, [
    { category: "failure", text: "NPM CI fails behind the proxy." },
    { category: "insight", text: "the retry loop masks the real error" },
  ]);
  assert.deepEqual(fresh.map((n) => n.text), ["the retry loop masks the real error"]);
});

test("the observer is blind to its own output and to the memory block", () => {
  const branch = [
    { id: "b", parentId: null, type: "custom_message", customType: "memory-context", content: "<memory>files</memory>" },
    msg("e1", "b", "user", "fix the build"),
    note("n1", "e1", [{ category: "failure", text: "the first attempt failed" }], "e1"),
    msg("e2", "n1", "assistant", "trying a different flag"),
  ];
  const slice = sliceTranscript(branch, null, ["memory-context", OBSERVATION_TYPE]);
  // Feeding an observer its own notes is how a list starts restating itself
  // with growing confidence and no new evidence.
  assert.equal(slice.text.includes("the first attempt failed"), false);
  assert.equal(slice.text.includes("<memory>"), false);
  assert.equal(slice.text.includes("fix the build"), true);
  assert.equal(slice.text.includes("trying a different flag"), true);
  // Coverage still advances over the skipped entries, so they are not
  // re-examined on every future run.
  assert.equal(slice.upToId, "e2");
});

test("an extension's custom message is conversation the observer must see", () => {
  // Entries reach the branch by more than one route. Requiring `message.role`
  // meant every custom_message read as empty, so the observer's own trigger
  // believed nothing had been said and it never ran at all.
  const branch = [
    { id: "c1", parentId: null, type: "custom_message", display: false, content: "a note from another extension" },
    { id: "c2", parentId: "c1", type: "custom_message", customType: "briefing", content: [{ type: "text", text: "and one with a type" }] },
    msg("e1", "c2", "user", "and an ordinary message"),
  ];
  const slice = sliceTranscript(branch, null, []);
  assert.match(slice.text, /a note from another extension/);
  assert.match(slice.text, /briefing: and one with a type/);
  assert.match(slice.text, /user: and an ordinary message/);
  assert.ok(charsSinceCoverage(branch, null, []) > 0);
});

test("coverage means the next run starts after what was read", () => {
  const branch = [
    msg("e1", null, "user", "one"),
    msg("e2", "e1", "assistant", "two"),
    msg("e3", "e2", "user", "three"),
  ];
  const after = sliceTranscript(branch, "e2", []);
  assert.equal(after.text, "user: three");
  assert.equal(after.upToId, "e3");
  // A coverage marker for an entry that is no longer on the branch must not
  // silently skip everything; it falls back to reading from the start.
  const dangling = sliceTranscript(branch, "gone", []);
  assert.equal(dangling.text.includes("user: one"), true);
});

test("a run is due only when enough new conversation has arrived", () => {
  const small = [msg("e1", null, "user", "hello")];
  assert.equal(
    shouldObserve({ enabled: true, inFlight: false, charsSinceCoverage: charsSinceCoverage(small, null, []) }),
    false,
  );
  const big = [msg("e1", null, "user", "x".repeat(OBSERVE_AFTER_CHARS + 10))];
  assert.equal(
    shouldObserve({ enabled: true, inFlight: false, charsSinceCoverage: charsSinceCoverage(big, null, []) }),
    true,
  );
  // Off, or already running, beats any amount of new text.
  assert.equal(shouldObserve({ enabled: false, inFlight: false, charsSinceCoverage: 1e9 }), false);
  assert.equal(shouldObserve({ enabled: true, inFlight: true, charsSinceCoverage: 1e9 }), false);
});

test("replay folds note entries and survives junk", () => {
  const branch = [
    note("n1", null, [{ category: "failure", text: "one" }], "e1"),
    { id: "x", parentId: "n1", type: "custom_message", customType: OBSERVATION_TYPE },
    { id: "y", parentId: "x", type: "custom_message", customType: OBSERVATION_TYPE, data: { notes: "not an array" } },
    note("n2", "y", [{ category: "bogus", text: "dropped" }, { category: "insight", text: "two" }], "e5"),
  ];
  const { notes, coversUpToId, dropped } = replayObservations(branch);
  assert.deepEqual(notes.map((n) => n.text), ["one", "two"]);
  assert.equal(coversUpToId, "e5");
  assert.equal(dropped, 0);
  assert.deepEqual(replayObservations([]), { notes: [], coversUpToId: null, dropped: 0 });
});

test("an empty run still advances coverage, so silence is not re-bought", () => {
  // The entry the extension writes when nothing was worth recording.
  const branch = [note("n1", null, [], "e9")];
  const { notes, coversUpToId } = replayObservations(branch);
  assert.deepEqual(notes, []);
  assert.equal(coversUpToId, "e9");
});

test("the cap is reported where the survivors are read, never silent", () => {
  // 45 notes across entries: 40 kept, and the block must say 5 fell off —
  // it calls the survivors "verbatim", and a silent cap under that label
  // loses corrections without anyone being told.
  const many = Array.from({ length: 45 }, (_, i) => ({ category: "insight", text: `note number ${i}` }));
  const branch = [note("n1", null, many, "e1")];
  const { notes, dropped } = replayObservations(branch);
  assert.equal(notes.length, 40);
  assert.equal(dropped, 5);
  // Newest kept: the first five are the ones gone.
  assert.equal(notes[0]!.text, "note number 5");
  const text = renderObservations(notes, dropped)!;
  assert.match(text, /5 older notes dropped at the 40-note cap/);
  assert.match(text, /gone, not summarised/);
  // And a list under the cap says nothing about caps.
  assert.equal(/dropped at the/.test(renderObservations(notes.slice(0, 3), 0)!), false);
});

test("the rendered section says what the notes are and are not", () => {
  assert.equal(renderObservations([]), null);
  const text = renderObservations([
    { category: "failure", text: "npm ci fails behind the proxy" },
    { category: "correction", text: "tabs, not spaces" },
  ])!;
  assert.match(text, /Notes from earlier in this session/);
  assert.match(text, /Verbatim, not re-summarised/);
  assert.match(text, /- \[failure\] npm ci fails behind the proxy/);
});

test("a note carrying a credential is something the secret gate catches", () => {
  // The observer reads the raw transcript, which is exactly where a pasted
  // key lives, and a note is re-injected into every request after a
  // compaction — so one leaked credential would be laundered from a single
  // message into all of them. The extension filters on this predicate.
  const leaked = parseObservations("[tool-quirk] the deploy script needs AKIAIOSFODNN7EXAMPLE to run");
  assert.equal(leaked.length, 1);
  assert.ok(scanForSecrets(leaked[0]!.text).length > 0);
  const clean = parseObservations("[tool-quirk] the deploy script needs an AWS key in the environment");
  assert.equal(scanForSecrets(clean[0]!.text).length, 0);
});

test("the status line can report the mix", () => {
  assert.deepEqual(
    countByCategory([
      { category: "failure", text: "a" },
      { category: "failure", text: "b" },
      { category: "insight", text: "c" },
    ]),
    [
      ["failure", 2],
      ["insight", 1],
    ],
  );
  assert.deepEqual(countByCategory([]), []);
});
