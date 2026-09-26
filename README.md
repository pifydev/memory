# @pify/memory

[![CI](https://github.com/pifydev/memory/actions/workflows/ci.yml/badge.svg)](https://github.com/pifydev/memory/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/@pify/memory)](https://www.npmjs.com/package/@pify/memory) [![npm downloads](https://img.shields.io/npm/dm/@pify/memory)](https://www.npmjs.com/package/@pify/memory)

Persistent memory for [pi](https://github.com/earendil-works/pi): durable facts, project conventions, and a daily activity log — all plain markdown you can read, edit, and commit.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install memory`](https://github.com/pifydev/cli) or `pi install npm:@pify/memory`.

## Why

Everything an agent learns about you disappears when the session ends: the convention it was corrected on, the command that fails behind your proxy, the reason the obvious fix does not work here. You explain it again next week.

The design constraint is that memory must never become a black box. Every file is markdown you can open, and the agent writes only when you ask or when a correction should stick — never through a surprise model call at shutdown that summarises your session into something you did not sanction.

## Storage

Two tiers, both plain markdown:

- **Global** — `~/.pi/agent/memory/`, holding `MEMORY.md` and `daily/YYYY-MM-DD.md`, for facts that follow you across projects.
- **Project** — `.pi/memory/MEMORY.md`, for conventions belonging to one repository. Commit it if the team should share it.

Daily logs are keyed by your **local** calendar day, not UTC, so "yesterday" means the day you actually worked.

## Tools

| Tool | Parameters | What it does |
|---|---|---|
| `memory_write` | `scope`: `global` \| `project` \| `daily`, `text`, `category?` | Save one entry |
| `memory_read` | `target`: `global` \| `project` \| `daily` \| `list`, `date?` | Read a memory file, or list the daily logs |
| `memory_search` | `query`, `limit?` (1–25, default 8) | Full-text search across every memory file |
| `memory_forget` | `pattern` | Delete matching entries, writing a recovery record first |
| `memory_restore` | `recoveryId` | Undo a `memory_forget` |

## Lessons that stop a repeat

`memory_write` takes an optional `category`: `failure`, `correction`, `insight`, `preference`, `convention`, or `tool-quirk`. It is stored as a readable bullet, so the files stay ordinary markdown:

```markdown
- [failure] npm ci fails behind the proxy, use --offline
```

Recent **failures and corrections are recalled unprompted** at the start of later sessions, newest first, capped at 8 entries and 30 days. "Newest first" means dated daily lessons (within the 30-day window) come first, most recent first, ahead of the undated `MEMORY.md` lessons, which are ordered last-written-first — so a correction you make today is recalled ahead of an undated one of unknown age, and today's is never crowded out by the oldest eight. A lesson you have to search for is a lesson that gets repeated; an old one about a file that no longer exists costs context and credibility. The other categories stay searchable but are not pushed at the agent.

## Behaviour

- **A repository's memory needs your consent.** `.pi/memory/MEMORY.md` is a file the repo ships, and this block goes in front of the model before your first prompt — a repo you had just cloned would otherwise get to speak first. pi's own project trust turned out to be necessary but not sufficient: pi asks about trust only when the repository ships one of the resources **pi itself** loads (`.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `SYSTEM.md`, `APPEND_SYSTEM.md`). A repo carrying only `.pi/memory/MEMORY.md` triggers no prompt, and `isProjectTrusted()` then returns true by default — measured, not assumed. So the question is this extension's to ask: once per project, remembered afterwards, refused in a headless run with no answer on record, and never able to override a project pi itself refused. `/memory` says the file was found and refused rather than pretending it does not exist. For CI, set `PIFY_TRUST_PROJECT=1` — an environment variable, because the repository being read cannot set one for itself.
- **Memory cannot break out of the block it travels in.** These files are hand-editable by design, so a line reading `</memory>` would otherwise end the block early and everything after it would arrive looking like this extension's own framing rather than like your notes. Such tags are neutralised and shown as data; nothing is silently dropped.
- **Current evidence wins.** The injected block says explicitly what to do when memory disagrees with the repository: prefer what you can see, and say that memory disagreed. Memory outlives the code it describes, and the project tier is a file anyone with repo access can edit.
- **It survives compaction.** A long session eventually compacts: pi keeps the most recent `keepRecentTokens` and folds everything older into a summary. The memory block is injected before your first prompt, which makes it the oldest entry in the session and guaranteed to be in the folded region — so without this, memory lasts until the first compaction and then quietly goes missing for the rest of the day's work. It is re-attached afterwards, **model-free**: pi's own summariser still writes the summary, and this puts your bytes back in front of it. Nothing is rewritten, and no surprise model call happens at the moment that temptation is strongest. Measured both ways — with re-injection disabled as a control, the memory appeared in **0 of 3** post-compaction requests and was not preserved in paraphrase either; with it, 3 of 3 (`bun run test/live/compact-survival.mjs`).
- **Cache-stable injection.** Memory arrives once per session as a hidden message before your first prompt — the capped `MEMORY.md` tiers, today's and yesterday's logs, and an overview of the searchable archive. It never touches the system prompt, so the provider request prefix stays stable and prompt caching keeps working. This is measured rather than asserted: `bun run test/live/wire.mjs` captures the real provider payload and checks that the content reached the model, that it is **not** in the system prompt, and that the system prompt is byte-identical across runs.
- **Secret gate.** Every write is scanned for AWS, GitHub, GitLab, Slack (tokens + webhooks), Stripe, SendGrid, Google (API + OAuth), OpenAI and npm keys, private key blocks, JWTs, `Authorization:` headers, credentials embedded in URLs, and `api_key=` assignments — and rejected with an explanation. Obvious non-secrets are let through so they don't block a real note: a doc example like `sk-xxxx…`, a template `${GITHUB_TOKEN}`, an env-var name, or a `changeme`/`REDACTED` placeholder. A secret with no recognisable shape is caught by its value instead: the values of the environment's secret-shaped variables (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*PASSWORD*`, …, 8+ characters, not a plain word or placeholder) and the password of any `scheme://user:pass@host` value are known to the gate for the session — compared against, never written down. Credentials must never enter files that are re-injected into every session.
- **Undoable forgetting.** `memory_forget` writes a recovery record before deleting and reports the id; `memory_restore <id>` puts the entries back.
- **One entry, one line.** A saved entry is one markdown bullet: `memory_forget` removes a single `-` line, `memory_restore` re-appends one line, and lessons/consolidation read the first line only. A multi-line `memory_write` is joined into a single bullet so it cannot leave orphan continuation lines that forget can never reach.
- **Concurrent writes do not clobber.** `~/.pi/agent/memory/MEMORY.md` and today's daily log are shared by every pi process on the machine. Writes append at the OS level rather than reading the whole file and writing it back, so two sessions saving at the same moment each keep their entry (worst case: a stray blank line) instead of the later write erasing the earlier one.
- **Real search, zero dependencies.** BM25 full-text search through SQLite FTS5 via `node:sqlite`, built into Node 24+ and Bun. On Node 22 hosts it falls back silently to an in-process paragraph scan. Either way `memory_search` works out of the box, with nothing to install.

## Session notes, if you turn them on

`/memory observe on` starts a background note-taker. Every few thousand characters of new conversation, a model reads the stretch it has not seen and records what would be expensive to rediscover — an approach that was tried and abandoned, a correction, a rule stated once in passing — in the same categories as lessons. `/memory notes` shows them.

Two boundaries make this safe enough to ship in a package built on not being a black box:

- **It never writes to your files.** Notes are branch-local session entries. `MEMORY.md` and the daily logs are still written only when you ask, or when the agent records a lesson with `memory_write`. Notes live and die with the session; promoting one to durable memory is a thing you do, not a thing that happens.
- **It is off until you turn it on**, per project. Turning it on is the sanction. `PIFY_MEMORY_OBSERVE=1` for headless runs, `PIFY_MEMORY_OBSERVE_AFTER_CHARS` to change the cadence.

Notes ride along inside the memory block, which means they arrive exactly when they are worth their tokens — [after a compaction](#it-survives-compaction) has folded away the conversation they came from. Before that the transcript is still there and the notes would be saying it twice.

Every note is **secret-scanned** before it is recorded. An observer reads the raw transcript, which is where a pasted key lives, and a note is re-injected into every request after a compaction — one leaked credential would be laundered from a single message into all of them.

Each observer run has a **deadline** (two minutes; consolidation gets three), enforced by a real `AbortSignal.timeout` handed straight to pi's model call. If the provider stream stalls, the signal fires and the call comes back aborted — the run fails loudly rather than leaving note-taking wedged for the rest of the process. The coverage marker stays put so the next run retries the same stretch, and `/memory` shows the timeout (or the provider's own error) under "last run failed" instead of silently going quiet.

**Honest status:** measured live on `openai/gpt-5.6` and `qwen3-235b`, which both record the stated rule correctly (`test/live/observe-wire.mjs`, 5/5 each). `anthropic/claude-opus-5` via openrouter returns no text through this path — root cause found by A/B in pi's source: pi's model catalog marks that model `supportsMidConvoEffort`, which adds beta headers and `output_config` marker messages that openrouter's anthropic passthrough cannot digest, and the reply comes back empty. Confirmed: 0 chars without an override, a normal answer with `providers.openrouter.modelOverrides["anthropic/claude-opus-5"].compat.supportsMidConvoEffort = false` in `~/.pi/agent/models.json`. Until pi fixes the catalog, that override is the fix; without it the run still fails loudly and `/memory` says so rather than advancing silently.

## Consolidation you asked for

`/memory consolidate <global|project|YYYY-MM-DD>` hands the file to a model that merges duplicates and drops facts a later entry already corrected.

It only ever *proposes*. The result is refused outright if it invents an entry appearing nowhere in the original, empties the file, or drops more than 60% of it. It passes the same secret gate as any other write. You see a preview and confirm. And the previous content is kept as a recovery record, so `/memory restore <id>` puts it back.

## Command

`/memory` — status: file paths, sizes, which search engine is active, and whether session notes are on. The project line says exactly what injection would do — `injected`, `NOT injected: refused`, `NOT injected: not yet asked`, or `(no project file)` — computed the same way the block itself is, so an env override or the live session answer is reflected rather than only the on-disk store.
`/memory observe on|off` — turn session note-taking on or off for this project.
`/memory notes` — what this session has noted so far.
`/memory search <query>` — search yourself, without going through the agent.
`/memory read <global|project|list|YYYY-MM-DD>` — print a memory file.
`/memory consolidate <global|project|YYYY-MM-DD>` — propose a merged, de-duplicated file.
`/memory restore <id>` — undo a `memory_forget` or a consolidation by its recovery id (the id printed by the deletion or in the "Undo with:" notice).
`/memory skill <name> <query>` — promote the lessons that match `<query>` into a pi skill at `<agentDir>/skills/<name>/SKILL.md`: you see the file, confirm, it is written and pi reloads. A procedure that keeps coming up as a `[failure]`/`[correction]` bullet becomes something discoverable by name. It passes the secret gate, is capped at 64KB, and never overwrites a skill this command did not write.

## Conflicts

This extension registers the `memory_*` tool names, so it cannot run alongside another that registers the same ones. If you have `pi-memory` installed, remove it first — the on-disk layout is compatible, so existing `MEMORY.md` files and daily logs carry over untouched:

```bash
pi remove npm:pi-memory
pify install memory
```

## License

MIT © [Pify maintainers](https://github.com/pifydev)
