/**
 * One dialog at a time, across every @pify extension in the process.
 *
 * pi's interactive host has no queue for extension dialogs: opening a second
 * `ui.select`/`ui.confirm`/`ui.input` while one is already up displaces the
 * first component without ever calling its cancel callback, so the first
 * dialog's promise never settles — the turn hangs (measured in pi's
 * interactive-mode source: showExtensionSelector clears and replaces the
 * active selector, and only hideExtensionSelector disposes it). This is a
 * real collision in this suite: ask-question opens a questionnaire while a
 * consent prompt (memory/swarm/workflow/subagent) or a yolo confirm can fire
 * in the same turn, and parallel tool calls make that ordinary.
 *
 * The fix is to never let a second dialog open until the first has closed.
 * A timeout would not help — releasing the lock while the dialog is still on
 * screen just re-creates the collision — so this is a plain FIFO mutex with
 * no deadline. It is deliberately keyed on a cross-realm `Symbol.for`, so all
 * eighteen packages share ONE queue even though each ships its own copy of
 * this file: the state lives on `globalThis`, not in any one module.
 *
 * Vendored per package, like consent.ts, so the suite keeps zero runtime
 * dependencies.
 */

const LOCK_KEY = Symbol.for("pify.ui-lock.tail");

interface LockGlobal {
  [LOCK_KEY]?: Promise<unknown>;
}

/**
 * Run `fn` only once every dialog queued before it has finished, and hold the
 * queue until `fn` settles. A rejection in an earlier holder never wedges the
 * chain — the next waiter proceeds regardless.
 */
export async function withUiLock<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as LockGlobal;
  const prev = g[LOCK_KEY] ?? Promise.resolve();

  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  g[LOCK_KEY] = prev.then(() => mine);

  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}
