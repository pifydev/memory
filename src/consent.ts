/**
 * Consent for project-supplied files that pi does not know about.
 *
 * `ctx.isProjectTrusted()` looked like the right gate, and for pi's own
 * project resources it is. But pi only *asks* about trust when the repository
 * ships one of the things pi itself loads — `.pi/settings.json`,
 * `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `SYSTEM.md`,
 * `APPEND_SYSTEM.md`. A repository carrying only `.pi/memory/MEMORY.md`
 * triggers no prompt at all, and `isProjectTrusted()` then returns true by
 * default. Measured, not assumed: a repo whose only pi file was
 * `.pi/memory/MEMORY.md` reported `isProjectTrusted=true`, while the same repo
 * with a `.pi/skills` directory reported false.
 *
 * So a file this extension invented needs consent this extension asks for. pi
 * saying no is still final — this can only ever be a second gate, never a way
 * around the first.
 */

/** What to do with a project-supplied file this session. */
export type ConsentVerdict = "allow" | "refuse" | "ask";

export interface ConsentInput {
  /** pi's own decision. False is final. */
  projectTrusted: boolean;
  /** What the user answered for this project before, if they ever did. */
  remembered: boolean | undefined;
  /** Whether there is a UI to ask through. */
  hasUI: boolean;
  /**
   * PIFY_TRUST_PROJECT, for headless runs. An environment variable is set by
   * whoever starts the process, never by the repository being read, so it is
   * a signal from the user and not from the code under inspection.
   */
  envOverride?: boolean;
}

/** Read PIFY_TRUST_PROJECT the same way everywhere. */
export function envConsent(env: Record<string, string | undefined>): boolean | undefined {
  const raw = env.PIFY_TRUST_PROJECT?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return undefined;
}

export function decideConsent(input: ConsentInput): ConsentVerdict {
  // pi already refused; nothing here may widen that.
  if (!input.projectTrusted) return "refuse";
  // An explicit answer from the person who started the process outranks a
  // remembered one — that is what typing it again means.
  if (input.envOverride !== undefined) return input.envOverride ? "allow" : "refuse";
  if (input.remembered === true) return "allow";
  if (input.remembered === false) return "refuse";
  // Headless runs cannot ask, and a file nobody approved must not be loaded
  // just because no one was there to say no.
  if (!input.hasUI) return "refuse";
  return "ask";
}

/**
 * Consent is per project *and* per kind of file: approving a repository's
 * memory says nothing about approving the agent definitions it also ships.
 */
export type ConsentFile = Record<string, Record<string, boolean>>;

export function readConsent(file: ConsentFile, cwd: string, scope: string): boolean | undefined {
  const entry = file[normalizeCwd(cwd)];
  if (!entry) return undefined;
  const value = entry[scope];
  return typeof value === "boolean" ? value : undefined;
}

export function writeConsent(
  file: ConsentFile,
  cwd: string,
  scope: string,
  allowed: boolean,
): ConsentFile {
  const key = normalizeCwd(cwd);
  return { ...file, [key]: { ...(file[key] ?? {}), [scope]: allowed } };
}

/** Tolerate anything on disk: a corrupt consent file means "never asked". */
export function parseConsent(raw: string | null): ConsentFile {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: ConsentFile = {};
    for (const [cwd, scopes] of Object.entries(data as Record<string, unknown>)) {
      if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) continue;
      const entry: Record<string, boolean> = {};
      for (const [scope, value] of Object.entries(scopes as Record<string, unknown>)) {
        if (typeof value === "boolean") entry[scope] = value;
      }
      if (Object.keys(entry).length > 0) out[cwd] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeCwd(cwd: string): string {
  return cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export function consentQuestion(what: string, path: string): string {
  return [
    `This project ships ${what}:`,
    `  ${path}`,
    "",
    "pi did not ask about it, because it is not one of the files pi itself loads.",
    "Load it for this project from now on?",
  ].join("\n");
}
