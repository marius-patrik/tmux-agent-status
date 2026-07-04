# tmux-agent-status

Compact tmux/psmux statusline segment that shows which AI coding agents are
running and how much subscription quota is left in the current window.

## What it shows

```
Codex ○ 88%/44% | Claude ○ 0%/39% | Kimi ● 12%/71% | Agy ○ G 100%/94% E 100%/100%
```

- **Provider name** in its own color.
- **Running indicator** right after the name:
  - `●` green  = attached interactive session is running the agent
  - `●` yellow = process is running but only detached/background
  - `○` red    = not running
  - `?` yellow = detection issue
- **Quota** as `5h% / weekly%` remaining in the current subscription window.
  - 5-hour value is white, weekly value is grey.
- **Agy** (Antigravity) has two sections: `G` (Gemini) and `E` (External).

## Supported agents

| Agent     | Quota source                                | Command used in TUI fallback |
|-----------|---------------------------------------------|------------------------------|
| Codex     | ChatGPT backend API → `/status` TUI         | `/status`                    |
| Claude    | Anthropic OAuth usage API → `/usage` TUI    | `/usage`                     |
| Kimi      | `api.kimi.com` usage API → `/usage` TUI     | `/usage`                     |
| Agy       | `/quota` TUI capture                        | `/quota`                     |

APIs are tried first; if they fail or are unavailable, the script drives the
CLI's own TUI in a detached tmux/psmux session and parses the output.

> **Note on Claude:** the TUI fallback attempts to reuse the stored OAuth token,
> but Claude Code may still prompt for a browser login in a fresh session. If the
> API is rate-limited, the last cached value is kept until the API recovers.

## Requirements

- Python 3.10+
- `psutil`
- tmux or [psmux](https://github.com/marlocarlo/psmux) (Windows)
- The agent CLIs installed and authenticated (`kimi`, `claude`, `codex`, `agy`)

## Installation

```bash
git clone https://github.com/marius-patrik/tmux-agent-status.git ~/tmux-agent-status
cd ~/tmux-agent-status
pip install psutil
```

## Configuration

Add to your `~/.tmux.conf` or `~/.psmux.conf`:

```tmux
# Make room for the segment
set -g status-right-length 200

# Start the daemon. Use the correct socket path for your tmux server.
run-shell "python3 ~/tmux-agent-status/launch-ai-status-daemon.py '#{socket_path}'"
```

The daemon appends the AI segment to whatever `status-right` you already have
(usually a clock/date suffix).

### Environment variables

| Variable          | Purpose                                              |
|-------------------|------------------------------------------------------|
| `PSMUX_BIN`       | Path to `psmux` / `tmux` binary                      |
| `PSMUX_SOCKET`    | tmux/psmux socket path passed by the launcher        |
| `AGENTS_ROOT`     | Root directory containing `.agents`                  |
| `AGENTS_HOME`     | Path to `.agents` directory                          |
| `KIMI_CODE_HOME`  | Override Kimi config home                            |

## How it works

1. `launch-ai-status-daemon.py` spawns a detached background daemon.
2. The daemon runs `ai-status.py` every 15 seconds.
3. `ai-status.py` checks psutil for running agent processes and, when APIs are
   unavailable, launches short-lived tmux/psmux sessions to send `/usage`,
   `/status`, or `/quota` commands and capture the screen.
4. The daemon sets `status-right` to the rendered segment followed by your
   original clock/date suffix.

## License

MIT
