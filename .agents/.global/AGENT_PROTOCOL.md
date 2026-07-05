# Agent Protocol

This file is intended to be reusable across repositories.

## Primary Rule

Build from explicit shared understanding. For meaningful changes, make the intent, assumptions, tradeoffs, and validation legible in the repo or the final handoff.

## Source Priority

Use this order when context conflicts:

1. Explicit user instructions in the current task.
2. Current repository files and live tool output.
3. Project-specific files in `.agents/.project/`.
4. Reusable rules in `.agents/.global/`.
5. Prior chat context or external memory.

## Behavior Contract

- Be direct and specific.
- Challenge weak assumptions, stale context, and hidden complexity.
- Preserve user changes; do not reset, delete, or overwrite unrelated work.
- Keep edits narrow and tied to the active spec or request.
- Explain meaningful decisions and deferred alternatives.
- Do not introduce hidden setup, unexplained dependencies, or silent conventions.
- Do not claim completion without validation evidence.

## No False Green

A passing command is useful evidence, not proof by itself.

- Define what behavior should be true.
- Run the repo-local checks that cover the change.
- For user-facing behavior, verify at the real boundary when practical.
- Report missing checks, skipped validation, and residual risk plainly.

## Delegation

Use subagents only for bounded sidecar work that materially helps the task:

- parallel repo inspection
- independent research
- focused implementation in a disjoint file set
- verification that can run while local work continues

The primary agent owns integration, final decisions, and the final report.
