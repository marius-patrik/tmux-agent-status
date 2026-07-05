# Docs And Memory

This file is intended to be reusable across repositories.

## Durable Context

Repository files are durable context. Chat history is not.

Keep project-specific continuity in `.agents/.project/`:

- `STATUS.md` for current state
- `HANDOFF.md` for pause or resume context
- `DECISIONS.md` for accepted and working decisions
- `DIALOGUE_LOG.md` for conversation-derived context that should survive sessions
- `PROJECT.md`, `STRUCTURE.md`, and `COMMANDS.md` for fast orientation

## Update Policy

Update `.agents/.project/` when a task changes:

- project direction
- commands or validation expectations
- architecture or file ownership
- open questions or non-goals
- current handoff state
- durable user preferences for the repo

Do not put project-specific names, paths, secrets, local machine state, or runtime-generated agent metadata into `.agents/.global/`.

## Runtime Metadata

Files such as `.agents/env`, `.agents/credits.json`, and `.agents/installs.json` are runtime state unless a project explicitly documents otherwise. Do not treat them as canonical shared repo content.
