import { test } from "node:test";
import assert from "node:assert/strict";
import { runPromptWithDeadline } from "../src/deadline.ts";

/**
 * The observer and consolidation timeouts used to be no-ops: they passed a
 * `signal` to `session.prompt()`, but pi's PromptOptions has no such field, so
 * a stalled provider stream waited forever. The deadline is now a timer that
 * aborts the session, and — because prompt() resolves NORMALLY after an abort —
 * the caller must be told the deadline fired so it discards the answer.
 */

/** A session whose prompt only settles when abort() is called. */
function stallingSession() {
  let resolvePrompt: (() => void) | undefined;
  let aborted = false;
  return {
    aborted: () => aborted,
    prompt(_text: string): Promise<unknown> {
      return new Promise<unknown>((resolve) => {
        resolvePrompt = () => resolve(undefined);
      });
    },
    abort(): void {
      aborted = true;
      // prompt() resolves normally after an abort, exactly like pi's session.
      resolvePrompt?.();
    },
  };
}

test("a stalled prompt is aborted at the deadline and reported timedOut", async () => {
  const session = stallingSession();
  const { timedOut } = await runPromptWithDeadline(session, "hello", 10);
  assert.equal(timedOut, true, "the deadline fired");
  assert.equal(session.aborted(), true, "the session was aborted");
});

test("a fast prompt resolves without timing out and is never aborted", async () => {
  const session = {
    aborted: false,
    async prompt(_text: string) {
      return undefined;
    },
    abort() {
      this.aborted = true;
    },
  };
  const { timedOut } = await runPromptWithDeadline(session, "hi", 60_000);
  assert.equal(timedOut, false, "a fast run does not time out");
  assert.equal(session.aborted, false, "a fast run does not abort the session");
});

test("the timer is cleared before returning, so it cannot fire on a disposed session", async () => {
  // If runPromptWithDeadline left its timer live, abort() would run after the
  // caller disposed the session. A short prompt with a longer deadline must
  // leave nothing pending: abort is never called.
  let abortCalls = 0;
  const session = {
    async prompt(_text: string) {
      return undefined;
    },
    abort() {
      abortCalls++;
    },
  };
  await runPromptWithDeadline(session, "hi", 20);
  // Wait past the (would-be) deadline; the cleared timer must not fire.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(abortCalls, 0, "the cleared timer did not abort after return");
});
