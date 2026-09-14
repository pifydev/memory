import type { SecretMatch } from "./types.ts";

/**
 * Secret scanning gate (pi-hermes-memory's idea): credentials must never be
 * persisted into memory files that get re-injected into every future session
 * and may be committed to git. Patterns favor precision over recall — a false
 * block on a real secret-looking string is acceptable; silently storing a
 * real key is not.
 *
 * Two halves: a set of high-signal, anchored provider patterns, and a
 * placeholder filter so the obvious NON-secrets those patterns also match — a
 * doc example `sk-xxxxxxxx…`, `password = changeme`, `token = ${GITHUB_TOKEN}`,
 * `apiKey = OPENAI_API_KEY` — do not block a legitimate note. The filter only
 * ever removes matches whose value is plainly a template, an env-var name, a
 * single repeated character, or a known placeholder word; anything with real
 * entropy still trips. (Provider prefixes + suppression from the betterleaks
 * ruleset study, kept as zero-dep regex.)
 */
interface Pattern {
  label: string;
  re: RegExp;
  /** Capture group holding the secret value; 0 = the whole match. */
  valueGroup?: number;
}

const PATTERNS: Pattern[] = [
  { label: "AWS access key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: "GitHub token", re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { label: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Slack webhook", re: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/ },
  { label: "Stripe key", re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/ },
  { label: "SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  { label: "Google OAuth secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { label: "OpenAI API key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "npm token", re: /\bnpm_[A-Za-z0-9]{36,}\b/ },
  { label: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    label: "assigned credential",
    re: /\b(api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["']?([A-Za-z0-9+/_-]{16,})["']?/i,
    valueGroup: 2,
  },
  // An HTTP Authorization header, whatever the scheme — the shape you get by
  // pasting a `curl -H` line or a captured request into a note. Anchored on
  // the literal "authorization" so it never fires on prose that merely says
  // "bearer" or "basic" (async-fork's redaction taught this leak path).
  {
    label: "authorization header",
    re: /\bauthorization\b\s*[:=]\s*["']?(?:bearer|basic|token)\s+(\S{8,})/i,
    valueGroup: 1,
  },
  // A bare bearer token with no header around it. "bearer" plus a 24-char
  // single token is a credential, not a sentence — "bearer of the news" and
  // "bearer authentication docs" both fall short of the length, so precision
  // holds. (Plain "basic" is too common a word to match unanchored.)
  { label: "bearer token", re: /\bbearer\s+([A-Za-z0-9._~+/-]{24,}={0,2})/i, valueGroup: 1 },
  // Credentials embedded in a URL: scheme://user:pass@host — git remotes,
  // database connection strings, authenticated curl URLs. `://x:y@` never
  // occurs in prose, so this is precise even though it blocks on save.
  { label: "credentials in URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/?#@]+:[^\s:/?#@]+@\S+/i },
];

/**
 * Is this matched value plainly a placeholder rather than a real secret? Kept
 * deliberately narrow: everything here is unambiguously not-a-credential, so a
 * real key (mixed-case, high-entropy) is never suppressed.
 */
export function isPlaceholderValue(raw: string): boolean {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s) return true;
  // Template / interpolation markers: ${VAR}, {{ x }}, %s, <token>, or a whole
  // value that is a single $ENV reference.
  if (/\$\{|\{\{|%[sdv]\b|<[A-Za-z_][A-Za-z0-9_]*>/.test(s)) return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return true;
  // A SCREAMING_SNAKE env-var NAME (has an underscore) is the name, not the key.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)) return true;
  // The value body (after any provider prefix) is one repeated character.
  const body = s.replace(/^(?:[rs]k|ghp|gho|ghu|ghs|ghr|glpat|npm|xox[a-z]|sk-ant|GOCSPX|SG|AIza|AKIA|ASIA)[-_.]?/i, "");
  if (body.length >= 4 && /^(.)\1+$/i.test(body)) return true;
  // Obvious placeholder words. (A pure run of one char like sk-xxxx… is caught
  // by the all-same-char body rule above, so we don't suppress on a stray xxxx
  // inside an otherwise real value.)
  if (/(?:change[_-]?me|example|placeholder|redacted|dummy|sample|your[-_ ]?(?:key|token|secret|password)|todo)/i.test(s)) {
    return true;
  }
  return false;
}

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { label, re, valueGroup } of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const value = valueGroup ? (m[valueGroup] ?? m[0]) : m[0];
    if (isPlaceholderValue(value)) continue; // a doc example / template, not a secret
    const raw = m[0];
    const preview = raw.length <= 12 ? `${raw.slice(0, 4)}…` : `${raw.slice(0, 8)}…${raw.slice(-2)}`;
    matches.push({ label, preview });
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
