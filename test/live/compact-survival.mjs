/**
 * Does injected memory survive a compaction?
 *
 * The block is a custom message at the top of the branch — which is exactly
 * the region a compaction folds into a summary. If nothing re-injects it, the
 * agent keeps its memory only until the first compaction of the session:
 * lessons and conventions silently vanish mid-session and return on the next
 * one. (The failure mode is pi-observational-memory's founding observation —
 * summaries lose exactly this kind of detail — arrived at from the opposite
 * direction.)
 *
 * The driver makes pi compact partway through one run and reads the provider
 * payload before and after. Only the bytes can settle it: the block is
 * invisible in the transcript by design.
 *
 * Measured with the `session_compact` re-injection disabled, as a control —
 * the marker appeared in 0 of 3 post-compaction requests and `<memory>` was
 * absent too, so the summariser does not preserve it in paraphrase either.
 * With re-injection: 3 of 3. This test therefore fails if the fix is removed,
 * which is the only thing that makes it worth running.
 *
 *   node test/live/compact-survival.mjs
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

// Assembled so the marker never appears literally in this file's own bytes on
// the prompt path; it must reach the payload through the memory block alone.
const MARKER = ["zq", "vx", "wu"].join("") + "-proxy-rule";

const home = mkdtempSync(join(tmpdir(), "pify-compact-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-compact-repo-"));
const memoryDir = join(home, "memory");
const agentDir = join(home, "agent");
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "const log = (data) => appendFileSync(process.env.SURVIVAL_OUT, JSON.stringify(data) + String.fromCharCode(10));",
  "export default function probe(pi) {",
  "  let requests = 0;",
  "  let compacted = false;",
  // prepareCompaction refuses a session with nothing worth summarizing, so
  // the conversation needs real bulk before pi will compact at all. This
  // stands in for the long working session the feature exists for. It is sent
  // from session_start AFTER the memory extension's own handler (extension
  // order follows the -e flags), so the memory block stays the oldest entry
  // — which is the whole point: it is always in the folded region.
  '  pi.on("session_start", () => {',
  "    const filler = Array.from({ length: 600 }, (_, i) =>",
  "      `line ${i}: the quick brown fox jumps over the lazy dog while reviewing pull requests and rotating logs.`",
  "    ).join(String.fromCharCode(10));",
  "    for (let i = 0; i < 10; i++) {",
  "      pi.sendMessage({ content: `background transcript chunk ${i}:` + String.fromCharCode(10) + filler, display: false });",
  "    }",
  "  });",
  '  pi.on("before_provider_request", (event) => {',
  "    requests += 1;",
  "    const payload = event.payload || {};",
  "    const messages = payload.messages || [];",
  "    const text = JSON.stringify(messages);",
  "    log({",
  "      n: requests,",
  "      afterCompact: compacted,",
  "      marker: text.includes(process.env.SURVIVAL_MARKER),",
  '      block: text.includes("<memory>"),',
  "      turns: messages.length,",
  "    });",
  "  });",
  // The compaction is left to pi's own threshold rather than ctx.compact().
  // A manual compact aborts the running turn, and in print mode the run is
  // already unwinding by then — every attempt ended in "Summarization failed:
  // This operation was aborted". Settings put the threshold below the very
  // first response instead (see SETTINGS), so pi compacts of its own accord
  // mid-turn and then carries on, giving a post-compaction request inside the
  // one `-p` run.
  '  pi.on("session_compact_failed", (event) => {',
  '    log({ compactionEnd: "failed", reason: event.reason, detail: String(event.errorMessage || "aborted=" + event.aborted) });',
  "  });",
  '  pi.on("session_compact", (event) => {',
  "    compacted = true;",
  '    log({ compactionEnd: "complete", reason: event.reason, fromExtension: event.fromExtension });',
  "  });",
  "}",
].join(NL);

// reserveTokens above any real context window makes `contextTokens >
// contextWindow - reserveTokens` true immediately, so pi compacts at the
// first opportunity. keepRecentTokens is small so the cut lands past the
// memory block — which is the situation being tested, not a contrived one:
// the block is the oldest entry in any session and every real compaction
// folds it.
const SETTINGS = JSON.stringify(
  { compaction: { enabled: true, reserveTokens: 100000000, keepRecentTokens: 2000 } },
  null,
  2,
);

try {
  mkdirSync(memoryDir, { recursive: true });
  // Isolated global settings via PI_CODING_AGENT_DIR, so the compaction
  // thresholds do not touch the real ~/.pi and no project .pi/settings.json
  // is created — the latter would make pi ask about project trust and change
  // what this test is measuring.
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), SETTINGS + NL);
  // Credentials live in the real agent dir, so an isolated one starts with no
  // provider at all. Copy just the auth file across; everything else stays
  // untouched by this run.
  const realAuth = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
  if (existsSync(realAuth)) copyFileSync(realAuth, join(agentDir, "auth.json"));
  else console.log("warning: no auth.json found; pi will have no provider");
  writeFileSync(
    join(memoryDir, "MEMORY.md"),
    `# Memory${NL}${NL}- [failure] npm ci fails behind the corporate proxy; the workaround is ${MARKER}${NL}- The user prefers tabs over spaces${NL}`,
  );
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "README.md"), "# demo" + NL);

  const run = spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", join(PKG, "extensions", "memory.ts"),
      "-e", probe,
      // Long enough to need several turns, so the run outlives the
      // compaction that fires partway through. Wrapped in literal double
      // quotes: unquoted sentences reach pi one prompt per word on Windows
      // under shell:true (see task/test/live/sweep-wire.mjs).
      "-p", '"Use the bash tool to run these three commands one at a time, waiting for each result: echo one, then echo two, then echo three. Then reply DONE and stop."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_MEMORY_DIR: memoryDir,
        SURVIVAL_OUT: out,
        SURVIVAL_MARKER: MARKER,
      },
    },
  );

  if (process.env.SURVIVAL_DEBUG) {
    console.log("--- stdout ---" + NL + String(run.stdout ?? "").slice(0, 1500));
    console.log("--- stderr ---" + NL + String(run.stderr ?? "").slice(0, 1500));
  }

  const lines = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const requests = lines.filter((l) => l.n !== undefined);
  for (const l of lines.filter((x) => x.compactionEnd)) {
    console.log(`compaction: ${l.compactionEnd} reason=${l.reason ?? "?"}${l.detail ? ` — ${l.detail}` : ""}`);
  }

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  for (const r of requests) {
    console.log(`request ${r.n}: afterCompact=${r.afterCompact} marker=${r.marker} block=${r.block} turns=${r.turns}`);
  }

  const before = requests.filter((r) => !r.afterCompact);
  const after = requests.filter((r) => r.afterCompact);

  check("a request happened before the compaction", before.length > 0, `${before.length}`);
  check("the memory block was injected before it", before.some((r) => r.marker && r.block));
  check("a request happened after the compaction", after.length > 0, `${after.length}`);
  check(
    "the memory survives the compaction",
    after.length > 0 && after.every((r) => r.marker),
    after.length > 0 ? `marker in ${after.filter((r) => r.marker).length}/${after.length} post-compact requests` : "no post-compact request",
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
