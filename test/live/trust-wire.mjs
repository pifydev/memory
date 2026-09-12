/**
 * Does an untrusted repository's memory reach the model?
 *
 * `.pi/memory/MEMORY.md` is a file the repository ships, and the injected
 * block goes in front of the model before your first prompt. If the trust
 * gate is wrong in either direction the failure is silent: either a cloned
 * repo gets to speak first, or your own project memory quietly stops working.
 * Only the provider payload can tell those apart, so this reads it.
 *
 *   bun run test/live/trust-wire.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

const MARKER = "sentinel-41724-project-memory";

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("before_provider_request", (event) => {',
  "    const payload = event.payload || {};",
  "    const messages = JSON.stringify(payload.messages || []);",
  "    const system = JSON.stringify(payload.system || payload.systemPrompt || '');",
  "    appendFileSync(process.env.TRUST_OUT, JSON.stringify({",
  "      inMessages: messages.includes(process.env.TRUST_MARKER),",
  "      inSystem: system.includes(process.env.TRUST_MARKER),",
  "    }) + String.fromCharCode(10));",
  "  });",
  "}",
].join(NL);

function run(label, trusted) {
  const home = mkdtempSync(join(tmpdir(), "pify-trust-home-"));
  const repo = mkdtempSync(join(tmpdir(), "pify-trust-repo-"));
  const out = join(home, "req.jsonl");
  const probe = join(home, "probe.ts");
  try {
    writeFileSync(probe, PROBE_SOURCE);
    writeFileSync(join(repo, "README.md"), "# demo" + NL);
    mkdirSync(join(repo, ".pi", "memory"), { recursive: true });
    writeFileSync(
      join(repo, ".pi", "memory", "MEMORY.md"),
      `# Project memory${NL}${NL}- ${MARKER}${NL}`,
    );

    const args = [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      "-e", join(PKG, "extensions", "memory.ts"),
      // Wrapped: unquoted sentences reach pi one prompt per word on Windows
      // under shell:true (see task/test/live/sweep-wire.mjs).
      "-p", '"Reply with the single word OK."',
    ];
    spawnSync("pi", args, {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        TRUST_OUT: out,
        TRUST_MARKER: MARKER,
        // The only headless way in is an env var the user sets — never
        // something the repository being read can set for itself.
        PIFY_TRUST_PROJECT: trusted ? "1" : "0",
      },
    });

    const requests = existsSync(out)
      ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return {
      label,
      requests: requests.length,
      inMessages: requests.some((r) => r.inMessages),
      inSystem: requests.some((r) => r.inSystem),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const untrusted = run("untrusted", false);
console.log(`untrusted: ${JSON.stringify(untrusted)}`);
check("the session ran", untrusted.requests > 0, `${untrusted.requests} request(s)`);
check(
  "an unapproved repository's memory never reaches the model",
  !untrusted.inMessages && !untrusted.inSystem,
);

const trusted = run("trusted", true);
console.log(`trusted:   ${JSON.stringify(trusted)}`);
check("a project the user approved does reach the model", trusted.inMessages);
check("and it does not go into the system prompt", !trusted.inSystem);

console.log(`${NL}${passed}/${passed + failed} passed`);
process.exitCode = failed === 0 ? 0 : 1;
