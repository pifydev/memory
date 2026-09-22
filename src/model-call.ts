/**
 * The one seam between this package's two background model calls — the observer
 * and consolidation — and pi's provider stack.
 *
 * pi 0.87 exposes `ctx.modelRegistry.streamSimple(model, context, options)`,
 * which resolves auth at request time through every configured provider and
 * honours a real `AbortSignal`. That replaced the old machinery this file used
 * to need: a `DefaultResourceLoader` that had to be `reload()`ed or it silently
 * dropped the system prompt, an in-memory `AgentSession`, a `dispose()`, and a
 * timer that called `session.abort()` because `prompt()` ignored signals and
 * resolved normally after an abort. Now the deadline IS the signal.
 *
 * A failure is encoded IN the resolved message, not thrown: streamSimple
 * resolves to an `AssistantMessage` with stopReason "aborted" (our timeout
 * signal fired) or "error" (a setup/provider failure, including auth) rather
 * than rejecting — though a missing-auth request can also throw synchronously.
 * `runModelCall` folds every one of those shapes into the same
 * `{ text, timedOut, error }`, so the observer and consolidation share one code
 * path and one set of tests, and each decides for itself what a timeout versus
 * an error means for it.
 *
 * Pure by construction: `runModelCall` takes the model call as an injectable
 * dependency, so a test stubs it with no provider, session, or signal in sight.
 */

/** The resolved AssistantMessage fields this package actually reads. */
export interface ModelReply {
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
}

/** Ask the model once and hand back the resolved reply, or throw (auth missing). */
export type CallModel = () => Promise<ModelReply>;

/** A background model call's outcome, classified for the caller. */
export interface ModelOutcome {
  /** The answer text, empty on any failure. */
  text: string;
  /** The deadline signal fired: an "aborted" reply. */
  timedOut: boolean;
  /** A failure detail (a throw, or an "error" stopReason), or null on success. */
  error: string | null;
}

/**
 * The answer text of a resolved message: its text blocks joined and trimmed.
 *
 * A thinking model can resolve to reasoning-only content with no text block at
 * all — measured on anthropic/claude-opus-5, which returned 0 characters where
 * openai/gpt-5.6 and qwen3-235b both answered. That yields "" here, which the
 * observer treats as a considered failure rather than a deliberate silence.
 */
export function replyText(content: ModelReply["content"]): string {
  return (content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("")
    .trim();
}

/**
 * Drive a background model call through an injectable seam and fold every
 * outcome shape into `{ text, timedOut, error }`:
 *  - a throw (streamSimple rejects when request auth is missing) → error;
 *  - stopReason "aborted" (our AbortSignal.timeout fired) → timedOut;
 *  - stopReason "error" (setup/provider failure encoded in the stream) → error;
 *  - anything else → the answer text (which may itself be empty).
 */
export async function runModelCall(call: CallModel): Promise<ModelOutcome> {
  let reply: ModelReply;
  try {
    reply = await call();
  } catch (err) {
    return { text: "", timedOut: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (reply.stopReason === "aborted") {
    return { text: "", timedOut: true, error: null };
  }
  if (reply.stopReason === "error") {
    return { text: "", timedOut: false, error: reply.errorMessage || "the model returned an error" };
  }
  return { text: replyText(reply.content), timedOut: false, error: null };
}
