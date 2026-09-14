import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoSecrets, scanForSecrets } from "../src/secrets.ts";

test("blocks the well-known credential shapes", () => {
  const samples: Array<[string, string]> = [
    ["AWS access key", "key is AKIA1234567890ABCDEF ok"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained token", "github_pat_11ABCDEFG0123456789abcdef"],
    ["Slack token", "xoxb-123456789012-abcdefghij"],
    ["OpenAI API key", "sk-abcdefghijklmnopqrstuvwx"],
    ["Google API key", `AIza${"Sy0-abcdefghijklmnopqrstuvwxyz01234".slice(0, 35)}`],
    ["npm token", "npm_abcdef0123456789ghijkl0123456789mnop"],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P"],
    ["assigned credential", 'api_key = "abcdef0123456789abcdef"'],
    ["GitLab token", "glpat-abcdefghijklmnopqrstuvwx"],
    ["Slack webhook", "https://hooks.slack.com/services/T00000000/B00000000/abcdefghijklmnopqrst"],
    ["Stripe key", "sk_live_abcdefghijklmnop0123"],
    ["SendGrid key", "SG.abcdefghijklmnop.qrstuvwxyz012345"],
    ["Google OAuth secret", "GOCSPX-abcdefghijklmnopqrstuvwx"],
    ["authorization header", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9realtoken"],
    ["authorization header", "authorization = Basic dXNlcjpzdXBlcnNlY3JldA=="],
    ["bearer token", "bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["credentials in URL", "clone https://user:ghp_abcdef0123456789@github.com/o/r.git"],
    ["credentials in URL", "postgres://admin:s3cr3tp4ss@db.internal:5432/app"],
  ];
  for (const [label, text] of samples) {
    const matches = scanForSecrets(text);
    assert.ok(matches.some((m) => m.label === label), `${label}: ${JSON.stringify(matches)}`);
    assert.throws(() => assertNoSecrets(text), /Refusing to save/, label);
  }
});

test("previews are redacted, never the full secret", () => {
  const [match] = scanForSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  assert.ok(match);
  assert.ok(match.preview.length < 15);
  assert.ok(match.preview.includes("…"));
});

test("obvious placeholders are not treated as secrets", () => {
  for (const ok of [
    "sk-xxxxxxxxxxxxxxxxxxxx", // a doc example: pure repeated char
    'password = "changeme-right-now"',
    "token = ${GITHUB_TOKEN}", // template interpolation
    "apiKey = OPENAI_API_KEY_VALUE", // a SCREAMING_SNAKE env-var name, not a key
    "secret = your-secret-here-xxxx",
    'api_key = "REDACTED_FOR_THE_DOCS"',
  ]) {
    assert.doesNotThrow(() => assertNoSecrets(ok), ok);
  }
});

test("normal prose passes", () => {
  for (const ok of [
    "user prefers pnpm over npm in this repo",
    "the API key lives in the OPENAI_API_KEY env var",
    "deploy runs at 6am UTC via GitHub Actions",
    "password reset flow uses a 6-digit code",
    // Words that start like an auth scheme but carry no token.
    "the reviewer covers basic responsibilities and edge cases",
    "bearer authentication is documented in the wiki",
    "we use bearer tokens stored in the vault", // "tokens" is only 6 chars
    // URLs without embedded credentials must pass — including host:port and
    // an SSH-style user@host, neither of which is a leak.
    "docs live at https://example.com:8080/guide",
    "the remote is git@github.com:pifydev/memory.git",
    "open https://user@example.com to see the profile",
  ]) {
    assert.doesNotThrow(() => assertNoSecrets(ok), ok);
  }
});
