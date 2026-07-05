# Validation

This file is intended to be reusable across repositories.

## Rule

Use `.agents/.project/COMMANDS.md` as the source of truth for local setup and validation commands.

## Baseline

Before claiming a change is done:

- Run the smallest relevant validation command.
- For shared behavior, run the broader project CI command when practical.
- If a command is missing, record the gap instead of inventing a result.
- If validation fails, fix the issue or report the exact failure and impact.

## Evidence

Final reports should include:

- commands run
- whether they passed or failed
- skipped checks and why
- remote CI status when a PR exists

## Boundaries

Do not treat snapshots, mocked tests, or typechecks as proof of full behavior when the change affects runtime, UI, deployment, storage, network behavior, or user workflows. Validate at the closest real boundary available.
