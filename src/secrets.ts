import type { SecretMatch } from "./types.ts";

/**
 * Secret scanning gate (pi-hermes-memory's idea): credentials must never be
 * persisted into memory files that get re-injected into every future session
 * and may be committed to git. Patterns favor precision over recall — a false
 * block on a real secret-looking string is acceptable; silently storing a
 * real key is not.
 */
const PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { label: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "OpenAI API key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "npm token", re: /\bnpm_[A-Za-z0-9]{36,}\b/ },
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    label: "assigned credential",
    re: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9+/_-]{16,}["']?/i,
  },
];

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { label, re } of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const raw = m[0];
      const preview =
        raw.length <= 12 ? `${raw.slice(0, 4)}…` : `${raw.slice(0, 8)}…${raw.slice(-2)}`;
      matches.push({ label, preview });
    }
  }
  return matches;
}

export function assertNoSecrets(text: string): void {
  const matches = scanForSecrets(text);
  if (matches.length > 0) {
    const list = matches.map((m) => `${m.label} (${m.preview})`).join(", ");
    throw new Error(
      `Refusing to save: the text contains what looks like ${list}. ` +
        "Memory files are re-injected into every session and may be committed — never store credentials. " +
        "Rephrase without the secret (e.g. name the env var that holds it).",
    );
  }
}
