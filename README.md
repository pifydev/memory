# @pify/memory

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
| `memory_search` | `query` | Full-text search across every memory file |
| `memory_forget` | `pattern` | Delete matching entries, writing a recovery record first |
| `memory_restore` | `recoveryId` | Undo a `memory_forget` |

## Lessons that stop a repeat

`memory_write` takes an optional `category`: `failure`, `correction`, `insight`, `preference`, `convention`, or `tool-quirk`. It is stored as a readable bullet, so the files stay ordinary markdown:

```markdown
- [failure] npm ci fails behind the proxy, use --offline
```

Recent **failures and corrections are recalled unprompted** at the start of later sessions, newest first, capped at 8 entries and 30 days. A lesson you have to search for is a lesson that gets repeated; an old one about a file that no longer exists costs context and credibility. The other categories stay searchable but are not pushed at the agent.

## Behaviour

- **Current evidence wins.** The injected block says explicitly what to do when memory disagrees with the repository: prefer what you can see, and say that memory disagreed. Memory outlives the code it describes, and the project tier is a file anyone with repo access can edit.
- **Cache-stable injection.** Memory arrives once per session as a hidden message before your first prompt — the capped `MEMORY.md` tiers, today's and yesterday's logs, and an overview of the searchable archive. It never touches the system prompt, so the provider request prefix stays stable and prompt caching keeps working. This is measured rather than asserted: `bun run test/live/wire.mjs` captures the real provider payload and checks that the content reached the model, that it is **not** in the system prompt, and that the system prompt is byte-identical across runs.
- **Secret gate.** Every write is scanned for AWS, GitHub, Slack, OpenAI, Google and npm keys, private key blocks, JWTs, and `api_key=` assignments, and rejected with an explanation. Credentials must never enter files that are re-injected into every session.
- **Undoable forgetting.** `memory_forget` writes a recovery record before deleting and reports the id; `memory_restore <id>` puts the entries back.
- **Real search, zero dependencies.** BM25 full-text search through SQLite FTS5 via `node:sqlite`, built into Node 24+ and Bun. On Node 22 hosts it falls back silently to an in-process paragraph scan. Either way `memory_search` works out of the box, with nothing to install.

## Consolidation you asked for

`/memory consolidate <global|project|YYYY-MM-DD>` hands the file to a model that merges duplicates and drops facts a later entry already corrected.

It only ever *proposes*. The result is refused outright if it invents an entry appearing nowhere in the original, empties the file, or drops more than 60% of it. It passes the same secret gate as any other write. You see a preview and confirm. And the previous content is kept as a recovery record, so `/memory restore <id>` puts it back.

## Command

`/memory` — status: file paths, sizes, and which search engine is active.
`/memory search <query>` — search yourself, without going through the agent.
`/memory read <global|project|list|YYYY-MM-DD>` — print a memory file.
`/memory consolidate <global|project|YYYY-MM-DD>` — propose a merged, de-duplicated file.

## Conflicts

This extension registers the `memory_*` tool names, so it cannot run alongside another that registers the same ones. If you have `pi-memory` installed, remove it first — the on-disk layout is compatible, so existing `MEMORY.md` files and daily logs carry over untouched:

```bash
pi remove npm:pi-memory
pify install memory
```

## License

MIT © [Pify maintainers](https://github.com/pifydev)
