/**
 * Wire probe: what pi would actually have sent.
 *
 * The suite's central design claim is that memory (and goal, btw, subagent)
 * inject through hidden messages and never touch the system prompt, so the
 * provider request prefix stays byte-identical and the prompt cache survives.
 * Until now that claim was only checked by reading the code.
 *
 * `before_provider_request` fires after the payload is assembled and before
 * the transport acts, so the payload is observable regardless of what the
 * request then does. (Technique from ilovepixelart/pi-code's e2e smoke, which
 * points the model at a dead port to need no credentials at all; this runs
 * against a real cheap model because resolving a fabricated provider is more
 * moving parts than the check is worth.)
 *
 *   PI_LIVE_PROVIDER=openrouter PI_LIVE_MODEL=qwen/qwen3-235b-a22b-2507 \n *     bun run test/live/wire.mjs
 *
 * Not part of `bun test`: it spawns pi and spends a fraction of a cent.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "..", "..");
const results = [];
function check(label, condition, detail = "") {
  results.push(Boolean(condition));
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const home = mkdtempSync(join(tmpdir(), "pify-wire-home-"));
const repo = mkdtempSync(join(tmpdir(), "pify-wire-repo-"));
const memoryDir = join(home, "memory");
const wire = join(home, "wire.jsonl");
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";

try {
  // Our own memory store, carrying a marker nothing else could produce.
  mkdirSync(join(memoryDir, "daily"), { recursive: true });
  writeFileSync(
    join(memoryDir, "MEMORY.md"),
    "# Long-term memory\n\n- The deploy target is Vercel, project WIREPROBE-MARKER\n" +
      "- [failure] WIREPROBE-LESSON: npm ci fails behind the proxy, use --offline\n",
  );

  const probe = join(home, "wire-probe.ts");
  writeFileSync(
    probe,
    [
      'import { appendFileSync } from "node:fs";',
      "export default function wireProbe(pi) {",
      '  pi.on("before_provider_request", (event) => {',
      `    appendFileSync(${JSON.stringify(wire)}, JSON.stringify(event) + "\\n");`,
      "  });",
      "}",
    ].join("\n"),
  );

  writeFileSync(join(repo, "README.md"), "# probe repo\n");

  const run = (prompt) =>
    spawnSync(
      "pi",
      [
        "--provider", PROVIDER,
        "--model", MODEL,
        "--no-extensions",
        "-e", probe,
        "-e", join(PKG, "extensions", "memory.ts"),
        "-p", prompt,
      ],
      {
        cwd: repo,
        env: { ...process.env, PI_MEMORY_DIR: memoryDir },
        encoding: "utf8",
        timeout: 180_000,
        shell: true,
        windowsHide: true,
      },
    );

  const first = run("say OK");
  const second = run("say OK again");

  const captured = existsSync(wire) ? readFileSync(wire, "utf8").split("\n").filter(Boolean) : [];
  check(
    "the probe captured provider payloads",
    captured.length >= 2,
    captured.length === 0 ? (first.stderr || second.stderr || "").slice(0, 200) : `${captured.length} requests`,
  );
  if (captured.length < 2) throw new Error("no payloads to assert on");

  const payloads = captured.map((line) => JSON.parse(line).payload);
  const systemOf = (payload) => {
    const direct = payload?.system ?? payload?.systemPrompt;
    if (typeof direct === "string") return direct;
    if (Array.isArray(direct)) return direct.map((part) => part?.text ?? "").join("");
    const first = (payload?.messages ?? []).find((m) => m?.role === "system");
    return typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
  };

  const a = payloads[0];
  const b = payloads[payloads.length - 1];
  check("memory reached the model", payloads.some((p) => JSON.stringify(p).includes("WIREPROBE-MARKER")));
  check(
    "and it is NOT in the system prompt",
    !systemOf(a).includes("WIREPROBE-MARKER"),
    "memory injects as a hidden message, which is what keeps the prefix stable",
  );
  check(
    "a recalled lesson reached the model",
    payloads.some((p) => JSON.stringify(p).includes("WIREPROBE-LESSON")),
  );
  check(
    "and the lesson is not in the system prompt either",
    !systemOf(a).includes("WIREPROBE-LESSON"),
  );
  check(
    "the system prompt is byte-identical across runs",
    systemOf(a) === systemOf(b),
    `${systemOf(a).length} vs ${systemOf(b).length} chars`,
  );
  check("the system prompt is not empty", systemOf(a).length > 100, `${systemOf(a).length} chars`);
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} wire checks passed`);
process.exitCode = passed === results.length ? 0 : 1;
