---
name: status
description: Print or summarize the current project status from `.agents/.project/STATUS.md`. Use when the user asks for status, current state, where things stand, repo truth, project orientation, or explicitly invokes $status.
---

# Status

Treat the repository as the source of truth.

Print the project status with:

```powershell
node .agents/.global/skills/status/scripts/print_status.mjs
```

If Node.js is unavailable but Bun is available, run:

```powershell
bun .agents/.global/skills/status/scripts/print_status.mjs
```

Answer from the printed status. If live repo state differs from the status file, say so and update `.agents/.project/STATUS.md` when the task calls for it.
