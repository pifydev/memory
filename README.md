# @pify/memory

Persistent memory for [pi](https://github.com/earendil-works/pi): durable facts, project conventions, and a daily activity log — all plain markdown you can read, edit, and commit.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install memory`](https://github.com/pifydev/cli) or `pi install npm:@pify/memory`.

## What it does

- **Two-tier markdown storage**: global `~/.pi/agent/memory/` (`MEMORY.md` + `daily/YYYY-MM-DD.md`) for cross-project facts, and `.pi/memory/MEMORY.md` for per-repository conventions. Files are yours — read them, edit them, commit the project tier to git.
- **Explicit learning**: the agent saves when you ask ("remember that…") or when a correction should stick — via tools, never via surprise LLM calls at shutdown.
- **Consolidation you asked for** (v0.3): `/memory consolidate <global|project|YYYY-MM-DD>` hands the file to a model that merges duplicates and drops facts a later entry already corrected. It only ever *proposes*: the result is refused outright if it invents an entry that appears nowhere in the original, empties the file, or drops more than 60% of it; it passes the same secret gate as any write; you see a preview and confirm; and the previous content is kept as a recovery record, so `/memory restore <id>` puts it back.
- **Lessons that stop a repeat** (v0.5): `memory_write` takes an optional `category` — `failure`, `correction`, `insight`, `preference`, `convention`, `tool-quirk` — stored as a readable bullet (`- [failure] npm ci fails behind the proxy, use --offline`), so the files stay plain markdown. Recent **failures and corrections are recalled unprompted** at session start, newest first, capped at 8 entries and 30 days: a lesson you have to search for is a lesson that gets repeated, and an old one about a file that no longer exists costs context and credibility. The other categories stay searchable but are not pushed. (Category vocabulary from [`pi-hermes-memory`](https://github.com/chandra447/pi-hermes-memory).)
- **Current evidence wins** (v0.5): the injected block now says what to do when memory disagrees with the repository — prefer what you can see, and say memory disagreed. Memory outlives the code it describes, and the project tier is a file anyone with repo access can edit.
- **Real search, zero dependencies**: BM25 full-text search through SQLite FTS5 via `node:sqlite` (built into Node 24+ and Bun); on Node 22 hosts it silently falls back to an in-process paragraph scan. Either way `memory_search` works out of the box.
- **Secret gate**: every write is scanned (AWS/GitHub/Slack/OpenAI/Google/npm keys, private key blocks, JWTs, `api_key=` assignments) and rejected with an explanation — credentials can never enter files that get re-injected into every session.
- **Undoable forgetting**: `memory_forget` writes a recovery record first; `memory_restore <id>` brings entries back.
- **Cache-stable injection**: memory is injected once per session as a hidden message before your first prompt (full `MEMORY.md` tiers capped + today/yesterday logs + an overview of the searchable archive) — the provider request prefix stays stable, so prompt caching keeps working. Measured, not asserted: `bun run test/live/wire.mjs` captures the real provider payload through `before_provider_request` and checks the marker reached the model, that it is **not** in the system prompt, and that the system prompt is byte-identical across runs (v0.4.1; technique from [`pi-code`](https://github.com/ilovepixelart/pi-code)).
- **Local-day discipline**: daily logs are keyed by your local calendar day, not UTC.

## Tools & command

| Surface | What it does |
|---|---|
| `memory_write` | Save one entry to `global` / `project` / `daily` |
| `memory_read` | Read any memory file, or list daily logs |
| `memory_search` | FTS5/scan search across all memory files |
| `memory_forget` | Delete matching entries (writes a recovery record) |
| `memory_restore` | Undo a forget by recovery id |
| `/memory` | Status: file paths, sizes, active search engine |
| `/memory search <query>` | Search memory yourself, without asking the agent |
| `/memory read <global\|project\|list\|YYYY-MM-DD>` | Print a memory file |
| `/memory consolidate <global\|project\|YYYY-MM-DD>` | Propose a merged, de-duplicated file (v0.3) |

## Migrating from pi-memory

`@pify/memory` uses the same on-disk layout as jayzeng's `pi-memory`, so your existing `MEMORY.md` and daily logs carry over untouched. The two register the same tool names and cannot run side by side — remove the old one first:

```bash
pi remove npm:pi-memory
pify install memory
```

## License

MIT © [Pify maintainers](https://github.com/pifydev)
