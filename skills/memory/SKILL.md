---
name: memory
description: Use when the user asks you to remember something, corrects you in a way that should stick, or asks about past work/decisions - explains when to use the memory tools and what belongs in each scope
---

# Persistent memory

This project has the `@pify/memory` extension installed. Memory is plain
markdown the user can read and edit: global `MEMORY.md` + daily logs under
`~/.pi/agent/memory/`, and project `.pi/memory/MEMORY.md`. A `<memory>` block
with current contents is injected at session start.

## When to save (memory_write)

- The user says "remember", "note", "from now on", "always/never do X".
- The user corrects you in a way that should outlive this session.
- A durable decision or convention emerges (tool choice, deploy quirk).

Choose the scope deliberately:
- `global` — true across every project (preferences, identity, habits).
- `project` — true for this repository (conventions, commands, gotchas).
- `daily` — what happened today (progress notes, session activity).

Keep entries to a sentence or two. Never store credentials — writes are
secret-scanned and rejected; name the env var that holds a secret instead.

## When to search (memory_search)

- The user references past work ("what did we decide about…", "last week").
- Before assuming something was never recorded — the archive overview in the
  `<memory>` block tells you how many daily logs are searchable.

## Deleting (memory_forget / memory_restore)

Only delete when the user asks. Always report the recoveryId so the user can
undo with memory_restore.

## Lessons

When something fails, the user corrects you, or a tool behaves in a way its
docs do not describe, save it with a `category`:

- `failure` — what was tried and what the error was. Not "the build broke";
  "npm ci fails behind the proxy with ETIMEDOUT, use --offline".
- `correction` — what the user told you not to repeat.
- `tool-quirk` — non-obvious behaviour of a tool, package manager, or API.
- `insight`, `preference`, `convention` — durable, but not urgent enough to
  push into the next session.

Recent failures and corrections arrive automatically at the start of later
sessions. Check them before retrying something that failed before; the point
of writing one down is that the mistake costs its explanation once.
