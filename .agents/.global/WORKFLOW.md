# Workflow

This file is intended to be reusable across repositories.

## Start

Before non-trivial work:

1. Read the root `AGENTS.md` if present.
2. Read `.agents/.global/` operating files.
3. Read `.agents/.project/` context, commands, status, and handoff files.
4. Check current branch, git status, open issue or PR context, and relevant docs.
5. Identify the narrowest safe scope for the task.

## Spec First

For non-trivial implementation:

- Prefer an issue, spec, or documented acceptance criteria before coding.
- If no spec exists, create or write the smallest useful one.
- Keep non-goals explicit when scope could expand.
- Update the spec or split the work if implementation reveals missing scope.

## Delivery Loop

Use this loop unless the project-specific rules say otherwise:

1. Issue or spec.
2. Feature branch.
3. Scoped implementation.
4. Local validation.
5. Pull request.
6. Remote CI or review.
7. Merge or explicit handoff.

## While Working

- Keep the working tree understandable.
- Stage only files that belong to the task.
- Prefer existing repo patterns over new conventions.
- Update project-specific `.agents/.project/` files when decisions, status, or handoff facts change.
- Stop only at a completed task or a concrete user decision.
