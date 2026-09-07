import { test } from "node:test";
import assert from "node:assert/strict";
import {
  envConsent,
  consentQuestion,
  decideConsent,
  parseConsent,
  readConsent,
  writeConsent,
} from "../src/consent.ts";

test("pi refusing the project is final", () => {
  // Nothing this extension asks may widen a decision pi already made.
  for (const remembered of [undefined, true, false]) {
    for (const hasUI of [true, false]) {
      assert.equal(decideConsent({ projectTrusted: false, remembered, hasUI }), "refuse");
    }
  }
});

test("a project nobody has been asked about gets asked once", () => {
  assert.equal(decideConsent({ projectTrusted: true, remembered: undefined, hasUI: true }), "ask");
  assert.equal(decideConsent({ projectTrusted: true, remembered: true, hasUI: true }), "allow");
  assert.equal(decideConsent({ projectTrusted: true, remembered: false, hasUI: true }), "refuse");
});

test("headless cannot ask, so headless refuses", () => {
  // A file nobody approved must not load just because no one was there to
  // say no — the same fail-closed rule as the rest of the suite.
  assert.equal(decideConsent({ projectTrusted: true, remembered: undefined, hasUI: false }), "refuse");
  // A remembered answer still stands without a UI: it was given deliberately.
  assert.equal(decideConsent({ projectTrusted: true, remembered: true, hasUI: false }), "allow");
});

test("consent is per project and per kind of file", () => {
  let file = writeConsent({}, "D:/repo", "memory", true);
  assert.equal(readConsent(file, "D:/repo", "memory"), true);
  // Approving the memory says nothing about the agent definitions.
  assert.equal(readConsent(file, "D:/repo", "agents"), undefined);
  // …nor about a different project.
  assert.equal(readConsent(file, "D:/other", "memory"), undefined);

  file = writeConsent(file, "D:/repo", "agents", false);
  assert.equal(readConsent(file, "D:/repo", "memory"), true, "the earlier answer survives");
  assert.equal(readConsent(file, "D:/repo", "agents"), false);
});

test("the project key survives separator and case differences", () => {
  const file = writeConsent({}, "D:\\Repo\\Thing\\", "memory", true);
  assert.equal(readConsent(file, "D:/repo/thing", "memory"), true);
});

test("a corrupt consent file means nobody was ever asked", () => {
  assert.deepEqual(parseConsent(null), {});
  assert.deepEqual(parseConsent("not json"), {});
  assert.deepEqual(parseConsent("[1,2,3]"), {});
  assert.deepEqual(parseConsent('{"D:/repo": "yes"}'), {});
  // Non-boolean values are dropped rather than coerced — "0" is not consent.
  assert.deepEqual(parseConsent('{"D:/repo": {"memory": "0"}}'), {});
  assert.deepEqual(parseConsent('{"D:/repo": {"memory": true, "agents": 1}}'), {
    "D:/repo": { memory: true },
  });
});

test("the question says why pi did not ask", () => {
  const q = consentQuestion("its own memory file", "D:/repo/.pi/memory/MEMORY.md");
  assert.match(q, /D:\/repo\/\.pi\/memory\/MEMORY\.md/);
  assert.match(q, /pi did not ask about it/);
});

test("an environment override is a signal from the user, not the repository", () => {
  // Headless CI needs a way in, and it must not be something a cloned repo
  // can set for itself — so it is an env var, not a file.
  const base = { projectTrusted: true, remembered: undefined, hasUI: false } as const;
  assert.equal(decideConsent({ ...base, envOverride: true }), "allow");
  assert.equal(decideConsent({ ...base, envOverride: false }), "refuse");
  // It outranks a remembered answer: typing it again is the point.
  assert.equal(decideConsent({ ...base, remembered: false, envOverride: true }), "allow");
  assert.equal(decideConsent({ ...base, remembered: true, envOverride: false }), "refuse");
  // But pi's refusal is still final.
  assert.equal(decideConsent({ ...base, projectTrusted: false, envOverride: true }), "refuse");
});

test("only unambiguous values count as an override", () => {
  assert.equal(envConsent({}), undefined);
  assert.equal(envConsent({ PIFY_TRUST_PROJECT: "" }), undefined);
  assert.equal(envConsent({ PIFY_TRUST_PROJECT: "maybe" }), undefined);
  assert.equal(envConsent({ PIFY_TRUST_PROJECT: " TRUE " }), true);
  assert.equal(envConsent({ PIFY_TRUST_PROJECT: "1" }), true);
  assert.equal(envConsent({ PIFY_TRUST_PROJECT: "no" }), false);
});
