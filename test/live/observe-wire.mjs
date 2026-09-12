/**
 * Does the observer actually record what was said, and only that?
 *
 *  1. A run happens and writes a `memory-observation` ledger entry — checked
 *     in the session file on disk, because the entry is silent by design.
 *  2. The note is about the transcript, not about the prompt's own example.
 *     An earlier prompt showed a worked example mentioning a lockfile flag
 *     and the model recorded the example's flag rather than the one actually
 *     stated, so this is checked by name.
 *  3. Nothing is written to the user's memory files. That is the promise the
 *     whole feature is shaped around, so it is asserted rather than assumed.
 *
 * Surviving a compaction is a separate claim with its own evidence, in
 * compact-survival.mjs: notes ride inside the memory block, and that block is
 * measured going in and coming out of a real fold.
 *
 *   node test/live/observe-wire.mjs
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const NL = String.fromCharCode(10);

// The rule the observer is meant to notice. Assembled so it is never a literal
// in this file on the prompt path.
const RULE = ["zq", "vx", "wu"].join("") + "-lockfile";

const home = mkdtempSync(join(tmpdir(), "pify-observe-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-observe-repo-"));
const memoryDir = join(home, "memory");
const agentDir = join(home, "agent");
const out = join(home, "requests.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "const log = (d) => appendFileSync(process.env.OBSERVE_OUT, JSON.stringify(d) + String.fromCharCode(10));",
  "export default function probe(pi) {",
  "  let requests = 0;",
  "  let compacted = false;",
  "  let turns = 0;",
  "  let kicked = false;",
  // Just enough bulk to clear the observer's threshold, and no more. An
  // earlier version put 18-36k characters of filler ahead of one stated rule
  // and the observer answered NONE — correctly, for what it was shown. A test
  // that drowns its own signal measures the filler, not the feature.
  '  pi.on("session_start", () => {',
  "    const filler = Array.from({ length: 12 }, (_, i) =>",
  "      `line ${i}: routine progress, nothing worth remembering here.`",
  "    ).join(String.fromCharCode(10));",
  "    for (let i = 0; i < 2; i++) {",
  "      pi.sendMessage({ content: `background chunk ${i}:` + String.fromCharCode(10) + filler, display: false });",
  "    }",
  "  });",
  '  pi.on("before_provider_request", (event) => {',
  "    requests += 1;",
  "    const text = JSON.stringify((event.payload && event.payload.messages) || []);",
  "    log({",
  "      n: requests,",
  "      afterCompact: compacted,",
  "      rule: text.includes(process.env.OBSERVE_RULE),",
  '      notesSection: text.includes("Notes from earlier in this session"),',
  "    });",
  "  });",
  // Print mode disposes the session as soon as the turn is done, and a
  // disposed session makes `pi.appendEntry` throw "ctx is stale" — so a
  // background observer that is still thinking loses its work. Awaiting here
  // holds the turn open; pi awaits extension handlers, and the memory
  // extension's own agent_end has already kicked the observer off by the time
  // this one runs. Nothing in the product waits like this: a real session is
  // simply still alive while its observer thinks.
  '  pi.on("agent_end", async () => {',
  "    turns += 1;",
  "    if (turns === 1) await new Promise((r) => setTimeout(r, 45000));",
  "  });",
  "}",
].join(NL);

// Normal reserve: nothing compacts on its own, so the run controls when it
// happens. keepRecentTokens is small so the cut folds the memory block — the
// situation being tested, and the one every real compaction produces.
const SETTINGS = JSON.stringify(
  { compaction: { enabled: true, keepRecentTokens: 500 } },
  null,
  2,
);

try {
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), SETTINGS + NL);
  const realAuth = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
  if (existsSync(realAuth)) copyFileSync(realAuth, join(agentDir, "auth.json"));
  else console.log("warning: no auth.json found; pi will have no provider");

  writeFileSync(join(memoryDir, "MEMORY.md"), `# Memory${NL}${NL}- The user prefers tabs over spaces${NL}`);
  const memoryBefore = readFileSync(join(memoryDir, "MEMORY.md"), "utf8");
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
      // The rule is stated as a correction, which is the shape the observer
      // is told to record. Wrapped in literal double quotes: unquoted
      // sentences reach pi one prompt per word on Windows under shell:true
      // (see task/test/live/sweep-wire.mjs).
      "-p",
      `"Correction, remember this project rule: every install in this repository must pass ${RULE} or the build is not reproducible. Acknowledge the rule, then reply DONE and stop."`,
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 420_000,
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_MEMORY_DIR: memoryDir,
        PIFY_MEMORY_OBSERVE: "1",
        PIFY_MEMORY_OBSERVE_AFTER_CHARS: "500",
        OBSERVE_OUT: out,
        OBSERVE_RULE: RULE,
        OBSERVE_DEBUG_FILE: join(home, "debug.log"),
      },
    },
  );

  const dbgFile = join(home, "debug.log");
  if (existsSync(dbgFile)) console.log("--- extension debug ---" + NL + readFileSync(dbgFile, "utf8").trim());
  if (process.env.OBSERVE_DEBUG) {
    console.log("--- stderr ---" + NL + String(run.stderr ?? "").slice(0, 1200));
  }

  const lines = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const requests = lines.filter((l) => l.n !== undefined);

  // The ledger entry is silent by design, so the session file is where it shows.
  const sessionRoot = join(agentDir, "sessions");
  const sessionFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".jsonl")) sessionFiles.push(full);
    }
  };
  if (existsSync(sessionRoot)) walk(sessionRoot);
  const observationEntries = sessionFiles
    .flatMap((f) => readFileSync(f, "utf8").split(NL).filter(Boolean))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.customType === "memory-observation");
  const recorded = observationEntries.flatMap((e) => e?.data?.notes ?? []);

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  console.log(
    `requests: ${requests.length}, compactions: ${lines.filter((l) => l.compaction).length}, ` +
      `observation entries: ${observationEntries.length}, notes: ${recorded.length}`,
  );
  for (const n of recorded) console.log(`  [${n.category}] ${n.text}`);

  check("the observer ran and wrote a ledger entry", observationEntries.length > 0, `${observationEntries.length}`);
  check("it recorded at least one note", recorded.length > 0, `${recorded.length}`);
  check(
    "the note it recorded is the rule that was stated",
    recorded.some((n) => String(n.text).includes(RULE)),
  );
  // The promise the whole feature is shaped around.
  check(
    "the user's memory file was not touched",
    readFileSync(join(memoryDir, "MEMORY.md"), "utf8") === memoryBefore,
  );
  check(
    "it did not copy the example from its own instructions",
    recorded.length > 0 && !recorded.some((n) => String(n.text).includes("frozen-lockfile")),
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
