/**
 * A deadline for a background model call.
 *
 * pi's `AgentSession.PromptOptions` has no `signal` field, so passing one to
 * `session.prompt()` is a silent no-op — the wait is unbounded, and a stalled
 * provider stream (no bytes, no error) would keep a background observer's
 * "in flight" flag true for the rest of the process, quietly disabling
 * note-taking with nothing to show why.
 *
 * The API pi does expose is `abort()`. So the deadline is a timer that aborts
 * the session. Two facts shape the contract: `prompt()` RESOLVES NORMALLY after
 * an abort (it does not reject), so a partially streamed answer could look like
 * a valid result; and the timer must be cleared before the session is disposed
 * so a fast run cannot abort an already-disposed session. This helper returns
 * whether the deadline fired; the caller MUST treat `timedOut === true` as a
 * failure and discard whatever `prompt()` left behind.
 */
export interface DeadlineSession {
  prompt(text: string): Promise<unknown>;
  abort(): Promise<void> | void;
}

export async function runPromptWithDeadline(
  session: DeadlineSession,
  text: string,
  timeoutMs: number,
): Promise<{ timedOut: boolean }> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void session.abort();
  }, timeoutMs);
  try {
    await session.prompt(text);
  } finally {
    // Clear before the caller disposes the session, so a fast run cannot fire
    // the timer against a disposed session.
    clearTimeout(timer);
  }
  return { timedOut };
}
