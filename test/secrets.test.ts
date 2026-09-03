import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoSecrets, scanForSecrets } from "../src/secrets.ts";

test("blocks the well-known credential shapes", () => {
  const samples: Array<[string, string]> = [
    ["AWS access key", "key is AKIAIOSFODNN7EXAMPLE ok"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GitHub fine-grained token", "github_pat_11ABCDEFG0123456789abcdef"],
    ["Slack token", "xoxb-123456789012-abcdefghij"],
    ["OpenAI API key", "sk-abcdefghijklmnopqrstuvwx"],
    ["Google API key", `AIza${"Sy0-abcdefghijklmnopqrstuvwxyz01234".slice(0, 35)}`],
    ["npm token", `npm_${"a".repeat(36)}`],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P"],
    ["assigned credential", 'api_key = "abcdef0123456789abcdef"'],
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

test("normal prose passes", () => {
  for (const ok of [
    "user prefers pnpm over npm in this repo",
    "the API key lives in the OPENAI_API_KEY env var",
    "deploy runs at 6am UTC via GitHub Actions",
    "password reset flow uses a 6-digit code",
  ]) {
    assert.doesNotThrow(() => assertNoSecrets(ok), ok);
  }
});
