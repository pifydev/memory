import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContextEntries } from "@earendil-works/pi-coding-agent";
import { isInjectedInContext } from "../src/inject.ts";

const TYPE = "memory-context";

/**
 * A branch shaped like a real session: the memory block first, then turns, then
 * a compaction entry that keeps only the tail. `buildContextEntries` is pi's
 * own function, so this pins behaviour against pi rather than against a guess
 * about pi — the failure mode that has bitten this suite before.
 */
function session() {
  const entries: Array<Record<string, unknown>> = [
    { id: "m", parentId: null, type: "custom_message", customType: TYPE, content: "<memory>…</memory>" },
  ];
  for (let i = 1; i <= 6; i++) {
    entries.push({
      id: `e${i}`,
      parentId: entries[entries.length - 1]!.id,
      type: "message",
      message: { role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: `turn ${i}` }] },
    });
  }
  return entries;
}

test("before a compaction the block is both on the branch and in context", () => {
  const entries = session();
  const context = buildContextEntries(entries as never, "e6");
  assert.equal(isInjectedInContext(entries, TYPE), true);
  assert.equal(isInjectedInContext(context, TYPE), true);
});

test("a compaction folds the block away — the branch still shows it, context does not", () => {
  const entries = session();
  // Keep from e5 onward; everything older becomes the summary. The memory
  // block is the oldest entry in any session, so it is always in that region.
  entries.push({
    id: "c1",
    parentId: "e6",
    type: "compaction",
    summary: "earlier conversation",
    firstKeptEntryId: "e5",
    tokensBefore: 30000,
  });
  const context = buildContextEntries(entries as never, "c1");

  // This is the whole bug in two lines: asking the branch says "already
  // injected" while the model can no longer see a word of it.
  assert.equal(isInjectedInContext(entries, TYPE), true);
  assert.equal(isInjectedInContext(context, TYPE), false);

  // And the kept tail really is the tail, so nothing else smuggled it back.
  assert.deepEqual(
    context.map((e) => (e as { id: string }).id),
    ["c1", "e5", "e6"],
  );
});

test("re-injecting after a compaction puts it back in context", () => {
  const entries = session();
  entries.push({
    id: "c1",
    parentId: "e6",
    type: "compaction",
    summary: "earlier conversation",
    firstKeptEntryId: "e5",
    tokensBefore: 30000,
  });
  entries.push({ id: "m2", parentId: "c1", type: "custom_message", customType: TYPE, content: "<memory>…</memory>" });

  const context = buildContextEntries(entries as never, "m2");
  assert.equal(isInjectedInContext(context, TYPE), true);
  // Injected after the compaction entry, so it is not folded by it.
  assert.ok(
    context.findIndex((e) => (e as { id: string }).id === "m2") >
      context.findIndex((e) => (e as { id: string }).id === "c1"),
  );
});

test("isInjectedInContext tolerates the entry shapes pi actually produces", () => {
  assert.equal(isInjectedInContext([], TYPE), false);
  assert.equal(isInjectedInContext([{ type: "message" }], TYPE), false);
  assert.equal(isInjectedInContext([{ customType: "other" }], TYPE), false);
  assert.equal(isInjectedInContext([null, undefined, { customType: TYPE }], TYPE), true);
});
