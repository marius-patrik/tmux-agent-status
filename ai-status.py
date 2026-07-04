#!/usr/bin/env python3
"""tmux-agent-status: compact tmux statusline segment for AI CLI activity and quota.

Shows per-provider running indicators and subscription-window quota (remaining %)
for Kimi, Claude, Codex, and Antigravity (agy).

Indicator semantics:
  ● green  = attached interactive tmux/psmux session is running the CLI
  ● yellow = process is running but only in a detached/background session
  ○ red    = not running
  ? yellow = detection error

Quota sources (API first, TUI fallback):
  - Kimi:  api.kimi.com/coding/v1/usages, fallback /usage TUI capture
  - Claude: Anthropic OAuth usage API
  - Codex:  ChatGPT backend-api usage, fallback /status TUI capture
  - Agy:    /quota TUI capture (Gemini and External sections)
"""
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import psutil

# Force UTF-8 stdout so status symbols render correctly in tmux.
# Use newline='' to avoid CRLF translation on Windows.
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(
        sys.stdout.buffer, encoding="utf-8", errors="replace", newline=""
    )

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
# Derive HOME from the script location so this works even when psmux runs the
# command with a stripped environment.
SCRIPT_DIR = Path(__file__).resolve().parent


def _home_dir() -> Path:
    """Resolve the user's home directory robustly.

    Prefer environment variables, then fall back to the script location.
    Supports both the legacy ~/.tmux/ai-status layout and the standalone
    ~/tmux-agent-status layout.
    """
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if home:
        return Path(home)
    # Legacy: ~/.tmux/ai-status -> ~/.tmux -> ~
    if SCRIPT_DIR.name == "ai-status" and SCRIPT_DIR.parent.name == ".tmux":
        return SCRIPT_DIR.parent.parent
    # Standalone: ~/tmux-agent-status -> ~
    return SCRIPT_DIR.parent


HOME_DIR = _home_dir()


def _psmux_bin() -> list[str]:
    """Return the tmux/psmux executable as a list argument (supports spaces)."""
    exe = os.environ.get("PSMUX_BIN", "psmux")
    return [exe]


STATUS_DIR = SCRIPT_DIR
CACHE_DIR = STATUS_DIR / "cache"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

CLIS = ["codex", "claude", "kimi", "agy"]
LABELS = {"kimi": "K", "claude": "C", "agy": "A", "codex": "X"}
NAMES = {"kimi": "Kimi", "claude": "Claude", "agy": "Agy", "codex": "Codex"}
COLORS = {
    "kimi": "#7aa2f7",   # blue
    "claude": "#ff9e64", # orange
    "agy": "#e0af68",    # yellow
    "codex": "#7dcfff",  # turquoise
}
AGY_SECTION_COLORS = {
    "G": "#bb9af7",  # purple
    "E": "#9ece6a",  # green
}
ACTIVE_SYMBOL = "●"
INACTIVE_SYMBOL = "○"
QUOTA_CACHE_TTL = 60  # seconds


def _agents_root() -> Path:
    env = os.environ.get("AGENTS_ROOT")
    if env:
        return Path(env)
    # Fallback: search upward from CWD for a directory containing .agents
    cwd = Path.cwd()
    for p in [cwd, *cwd.parents]:
        if (p / ".agents").is_dir():
            return p
    return HOME_DIR


def _agents_home() -> Path:
    env = os.environ.get("AGENTS_HOME")
    if env:
        return Path(env)
    return _agents_root() / ".agents"


def _cli_home(cli: str) -> Path | None:
    """Resolve the data/home directory for each managed CLI."""
    agents = _agents_home()
    managed = agents / "clis" / cli
    if managed.exists():
        return managed

    env = os.environ.get("KIMI_CODE_HOME")
    if cli == "kimi" and env:
        home = _expand(env)
    else:
        fallbacks = {
            "kimi": HOME_DIR / ".kimi-code",
            "claude": HOME_DIR / ".claude",
            "gemini": HOME_DIR / ".gemini",
            "codex": HOME_DIR / ".codex",
        }
        home = fallbacks.get(cli)
    if home:
        home = home.resolve()
        if home.exists():
            return home
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _read_json(path: Path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return json.load(f)
    except Exception:
        return None


def _write_json(path: Path, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception:
        pass


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# Running detection via psutil
# ---------------------------------------------------------------------------
def _proc_matches(proc: psutil.Process, cli: str) -> tuple[bool, bool]:
    """Check if a process corresponds to the given CLI.

    Returns (matched, error) where error is True only if access to a process
    that looks like the target CLI (by name) was denied.
    """
    try:
        name = proc.name().lower()
        cmdline = " ".join(proc.cmdline()).lower()
    except psutil.NoSuchProcess:
        return False, False
    except psutil.AccessDenied:
        # Only flag a detection error if the process name itself resembles the CLI.
        name = proc.info.get("name", "").lower() if hasattr(proc, "info") else ""
        resembles = {
            "kimi": name == "kimi.exe",
            "claude": name.startswith("claude"),
            "gemini": name == "agy.exe",
            "codex": name in ("codex.exe", "node.exe"),
        }
        return False, resembles.get(cli, False)

    matchers = {
        "kimi": lambda: name == "kimi.exe",
        "claude": lambda: name.startswith("claude") or "claude-code" in cmdline,
        "gemini": lambda: "cli exec agy" in cmdline or name == "agy.exe",
        "codex": lambda: "@openai/codex" in cmdline or name == "codex.exe",
    }
    return matchers.get(cli, lambda: False)(), False


def _attached_sessions() -> dict[str, bool]:
    """Return which CLIs have an attached psmux pane running them."""
    attached = {cli: False for cli in CLIS}
    env = os.environ.copy()
    env.pop("PSMUX_SESSION", None)
    env.pop("TMUX", None)
    try:
        result = subprocess.run(
            _psmux_bin() + ["list-panes", "-a", "-F", "#{session_name} #{session_attached} #{pane_pid} #{pane_current_command}"],
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
            errors="replace",
        )
        if result.returncode != 0:
            return attached
        for line in result.stdout.splitlines():
            parts = line.strip().split(None, 3)
            if len(parts) < 4:
                continue
            session_name, attached_flag, pane_pid, _current_command = parts
            if attached_flag != "1":
                continue
            try:
                proc = psutil.Process(int(pane_pid))
            except Exception:
                continue
            procs_to_check = [proc]
            try:
                procs_to_check.extend(proc.children(recursive=True))
            except Exception:
                pass
            for candidate in procs_to_check:
                for cli in CLIS:
                    if attached[cli]:
                        continue
                    matched, _ = _proc_matches(candidate, cli)
                    if matched:
                        attached[cli] = True
    except Exception:
        pass
    return attached


def _running(now: float) -> dict[str, str]:
    """Return per-CLI state: 'on' (attached), 'bg' (process only), 'off', or 'err'."""
    found = {cli: False for cli in CLIS}
    errors = {cli: False for cli in CLIS}
    for proc in psutil.process_iter(["pid", "name"]):
        for cli in CLIS:
            if found[cli]:
                continue
            matched, err = _proc_matches(proc, cli)
            if matched:
                found[cli] = True
            if err:
                errors[cli] = True

    attached = _attached_sessions()
    return {
        cli: "err" if errors[cli] else ("on" if attached[cli] else ("bg" if found[cli] else "off"))
        for cli in CLIS
    }


# ---------------------------------------------------------------------------
# Quota fetchers
# ---------------------------------------------------------------------------
def _tui_capture(
    command: str,
    slash: str,
    wait_start: int = 5,
    wait_cmd: int = 5,
    env_overrides: dict | None = None,
    login_prompts: list[tuple[str, list[str]]] | None = None,
) -> str:
    """Start a CLI in a detached psmux session, send a slash command, and return pane output.

    Optionally handles simple login prompts before sending the slash command.
    Each login prompt is a tuple of (substring_to_detect, keys_to_send).
    """
    import random

    session = f"ai-quota-{command}-{random.randint(1000, 999999)}"
    env = os.environ.copy()
    env.pop("PSMUX_SESSION", None)
    env.pop("TMUX", None)
    env["MSYS_NO_PATHCONV"] = "1"
    if env_overrides:
        env.update(env_overrides)

    def psmux(*args, **kwargs):
        return subprocess.run(
            _psmux_bin() + list(args),
            env=env,
            stdout=kwargs.get("stdout", subprocess.DEVNULL),
            stderr=kwargs.get("stderr", subprocess.DEVNULL),
            check=kwargs.get("check", False),
            timeout=kwargs.get("timeout", 10),
        )

    def capture() -> str:
        return subprocess.run(
            ["psmux", "capture-pane", "-t", f"{session}:{command}", "-p", "-S", "-80", "-E", "80"],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            errors="replace",
        ).stdout

    out = ""
    try:
        psmux(
            "new-session",
            "-d",
            "-s",
            session,
            "-n",
            command,
            "-x",
            "300",
            "-y",
            "50",
            command,
            check=True,
            timeout=10,
        )
        time.sleep(wait_start)

        # Handle optional login prompts before sending the slash command.
        if login_prompts:
            out = capture()
            for prompt, keys in login_prompts:
                if prompt in out:
                    for key in keys:
                        if key == "Enter":
                            psmux("send-keys", "-t", f"{session}:{command}", "Enter")
                        else:
                            psmux("send-keys", "-t", f"{session}:{command}", key)
                    time.sleep(2)
                    out = capture()

        psmux("send-keys", "-t", f"{session}:{command}", slash, "Enter")
        time.sleep(wait_cmd)
        out = capture()
    except Exception:
        pass
    finally:
        try:
            psmux("kill-session", "-t", session)
        except Exception:
            pass
    return out


def _cached_quota(name: str, fetcher, now: float) -> dict | None:
    cache_file = CACHE_DIR / f"{name}_quota.json"
    cached = _read_json(cache_file)
    if cached and now - cached.get("fetched_at", 0) < QUOTA_CACHE_TTL:
        return cached

    fresh = fetcher()
    if fresh:
        fresh["fetched_at"] = now
        _write_json(cache_file, fresh)
        return fresh
    return cached


def _http_get_json(url: str, token: str, timeout: int = 5, user_agent: str | None = None) -> dict | None:
    """Make an authenticated GET request and return the JSON body."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if user_agent:
        headers["User-Agent"] = user_agent
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


def _read_token(path: Path, *keys: str) -> str | None:
    """Read a nested token from a JSON credential file."""
    data = _read_json(path)
    if not data:
        return None
    for key in keys:
        if not isinstance(data, dict):
            return None
        data = data.get(key)
    return data if isinstance(data, str) else None


def _fetch_kimi_quota_api() -> dict | None:
    """Fetch Kimi quota from the managed Kimi API."""
    home = _cli_home("kimi")
    if not home:
        return None
    token = _read_token(home / "credentials" / "kimi-code.json", "access_token")
    if not token:
        return None

    data = _http_get_json("https://api.kimi.com/coding/v1/usages", token, timeout=5)
    if not data:
        return None

    usage = data.get("usage", {})
    limits = data.get("limits", [])
    five_hour = next(
        (
            lim
            for lim in limits
            if lim.get("window", {}).get("duration") == 300
            and lim.get("window", {}).get("timeUnit") == "TIME_UNIT_MINUTE"
        ),
        None,
    )
    return {
        "five_hour_left": _bucket_left_pct(five_hour.get("detail") if five_hour else None),
        "weekly_left": _bucket_left_pct(usage),
    }


def _fetch_kimi_quota_tui() -> dict | None:
    """Fetch Kimi quota by driving the TUI's /usage screen."""
    out = _tui_capture("kimi", "/usage", wait_start=5, wait_cmd=4)
    if "Plan usage" not in out:
        return None

    section = out.split("Plan usage", 1)[1]

    def _parse_limit(label: str) -> int | None:
        m = re.search(
            rf"{label}\s+limit\s+[^\n]*?\s+(\d{{1,3}})%\s+used",
            section,
            re.I,
        )
        if m:
            return 100 - int(m.group(1))
        return None

    five = _parse_limit("5h")
    weekly = _parse_limit("Weekly")
    if five is not None or weekly is not None:
        return {"five_hour_left": five, "weekly_left": weekly}
    return None


def _fetch_kimi_quota() -> dict | None:
    """Fetch Kimi quota: API first, TUI fallback."""
    return _fetch_kimi_quota_api() or _fetch_kimi_quota_tui()


def _fetch_codex_quota_api() -> dict | None:
    """Fetch Codex quota from the ChatGPT backend API."""
    auth_path = _cli_home("codex")
    if auth_path:
        auth_path = auth_path / "auth.json"
    else:
        auth_path = HOME_DIR / ".codex" / "auth.json"
    token = _read_token(auth_path, "tokens", "access_token")
    if not token:
        return None

    data = _http_get_json(
        "https://chatgpt.com/backend-api/wham/usage",
        token,
        timeout=5,
        user_agent="codex-tui/0.142.5",
    )
    if not data:
        return None

    rate = data.get("rate_limit", {})
    return {
        "five_hour_left": _to_left(rate.get("primary_window", {}).get("used_percent")),
        "weekly_left": _to_left(rate.get("secondary_window", {}).get("used_percent")),
    }


def _fetch_codex_quota_tui() -> dict | None:
    """Fetch Codex quota by driving the TUI's /status screen."""
    out = _tui_capture("codex", "/status", wait_start=8, wait_cmd=8)
    m = re.search(
        r"5h\s+(\d{1,3})%\s+left\s+.*weekly\s+(\d{1,3})%\s+left",
        out,
        re.I,
    )
    if m:
        return {"five_hour_left": int(m.group(1)), "weekly_left": int(m.group(2))}
    m = re.search(r"5h\s+(\d{1,3})%\s+left", out, re.I)
    if m:
        return {"five_hour_left": int(m.group(1)), "weekly_left": None}
    return None


def _fetch_codex_quota() -> dict | None:
    """Fetch Codex quota: API first, TUI fallback."""
    return _fetch_codex_quota_api() or _fetch_codex_quota_tui()


def _fetch_claude_quota_api() -> dict | None:
    """Fetch Claude 5h/weekly quota from the Anthropic OAuth usage API."""
    token = _read_token(HOME_DIR / ".claude" / ".credentials.json", "claudeAiOauth", "accessToken")
    if not token:
        return None

    data = _http_get_json(
        "https://api.anthropic.com/api/oauth/usage",
        token,
        timeout=8,
        user_agent="ClaudeCode/2.1.200",
    )
    if not data:
        return None

    return {
        "five_hour_left": _to_left(data.get("five_hour", {}).get("utilization")),
        "weekly_left": _to_left(data.get("seven_day", {}).get("utilization")),
    }


def _fetch_claude_quota_tui() -> dict | None:
    """Fetch Claude quota by driving the TUI's /usage screen.

    This is a best-effort fallback. Claude Code may prompt for login/OAuth
    in a fresh session, in which case we abort and rely on the cached value
    until the API succeeds again.
    """
    token = _read_token(HOME_DIR / ".claude" / ".credentials.json", "claudeAiOauth", "accessToken")
    env = os.environ.copy()
    if token:
        # If the OAuth token is usable as an API key, this lets the TUI skip
        # the browser login flow. Fall back to prompting otherwise.
        env["ANTHROPIC_API_KEY"] = token

    out = _tui_capture(
        "claude",
        "/usage",
        wait_start=8,
        wait_cmd=5,
        env_overrides=env,
        login_prompts=[
            ("Detected a custom API key", ["1", "Enter"]),
            ("Select login method", ["1", "Enter"]),
        ],
    )

    # Claude /usage output typically shows:
    #   Five Hour Window: 12% used  -> 88% remaining
    #   Seven Day Window: 34% used  -> 66% remaining
    m = re.search(
        r"(?:Five Hour|5h).*?(\d{1,3})%\s+used.*?Seven Day.*?(\d{1,3})%\s+used",
        out,
        re.S | re.I,
    )
    if m:
        return {
            "five_hour_left": _to_left(int(m.group(1))),
            "weekly_left": _to_left(int(m.group(2))),
        }
    return None


def _fetch_claude_quota() -> dict | None:
    """Fetch Claude quota: API first, TUI fallback."""
    return _fetch_claude_quota_api() or _fetch_claude_quota_tui()


def _parse_agy_section(out: str, header: str) -> dict | None:
    """Parse a Models & Quota section (GEMINI MODELS or CLAUDE AND GPT MODELS)."""
    parts = re.split(rf"{header}", out, flags=re.I)
    if len(parts) <= 1:
        return None
    section = parts[1]

    def _parse_limit(label: str) -> int | None:
        pattern = (
            rf"{label}\s+Limit\s+.*?\n\s*(?:\[.*?\]\s+)?(\d{{1,3}}(?:\.\d+)?)%\s+(?:remaining|available)"
            rf"|{label}\s+Limit\s+.*?\n\s*(?:\[.*?\]\s+)?(Quota available)"
        )
        m = re.search(pattern, section, re.S | re.I)
        if not m:
            return None
        if m.group(2):
            return 100
        return round(float(m.group(1)))

    five = _parse_limit("Five Hour")
    weekly = _parse_limit("Weekly")
    if five is not None or weekly is not None:
        return {"five_hour_left": five, "weekly_left": weekly}
    return None


def _fetch_agy_quota() -> dict[str, dict | None]:
    """Fetch Agy quotas from the /quota screen (G=Gemini, E=External sections)."""
    out = _tui_capture("agy", "/quota", wait_start=4, wait_cmd=4)
    if not out or "Models & Quota" not in out:
        return {"G": None, "E": None}
    return {
        "G": _parse_agy_section(out, "GEMINI MODELS"),
        "E": _parse_agy_section(out, "CLAUDE AND GPT MODELS"),
    }


def _fetch_agy_quota_main() -> dict | None:
    """Return Agy quota data for the cache (includes sub-sections)."""
    sections = _fetch_agy_quota()
    if not any(sections.values()):
        return None
    return {"sections": sections}


def _bucket_left_pct(bucket: dict | None) -> int | None:
    """Return remaining percentage for a Kimi-style usage bucket."""
    if not bucket:
        return None
    limit = bucket.get("limit")
    used = bucket.get("used")
    remaining = bucket.get("remaining")
    if limit is not None and used is not None:
        try:
            return round(100 * (int(limit) - int(used)) / int(limit))
        except Exception:
            pass
    if limit is not None and remaining is not None:
        try:
            return round(100 * int(remaining) / int(limit))
        except Exception:
            pass
    return None


def _to_left(used_pct: int | float | None) -> int | None:
    """Convert a used percentage to a remaining percentage."""
    if used_pct is None:
        return None
    try:
        return max(0, 100 - round(float(used_pct)))
    except Exception:
        return None


def _quota(now: float) -> dict[str, dict | None]:
    return {
        "kimi": _cached_quota("kimi", _fetch_kimi_quota, now),
        "codex": _cached_quota("codex", _fetch_codex_quota, now),
        "claude": _cached_quota("claude", _fetch_claude_quota, now),
        "agy": _cached_quota("agy", _fetch_agy_quota_main, now),
    }


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------
def _fmt_quota(quota: dict | None) -> str:
    """Format remaining quota as five-hour / weekly percentages (tmux-escaped).

    The 5-hour (primary) window is shown in white and the weekly window in grey.
    """
    if not quota:
        return "--"
    five = quota.get("five_hour_left")
    week = quota.get("weekly_left")
    five_s = f"{five}%%" if five is not None else "--"
    week_s = f"{week}%%" if week is not None else "--"
    return f"#[fg=#c0caf5]{five_s}#[fg=#565f89]/{week_s}#[default]"


def _render(now: float) -> str:
    running = _running(now)
    quota = _quota(now)

    # Indicator states:
    #   on  = attached interactive session (green)
    #   bg  = process running but no attached session (yellow)
    #   off = nothing running (red)
    #   err = detection issue (yellow)
    indicator_colors = {"on": "#9ece6a", "bg": "#e0af68", "off": "#f7768e", "err": "#e0af68"}
    symbols = {"on": ACTIVE_SYMBOL, "bg": INACTIVE_SYMBOL, "off": INACTIVE_SYMBOL, "err": "?"}

    parts = []
    for cli in CLIS:
        color = COLORS[cli]
        state = running[cli]
        ind_color = indicator_colors[state]
        sym = symbols[state]
        q = quota[cli]

        if cli == "agy" and q and "sections" in q:
            # Agy aggregates multiple sections: Agy G:../.. E:../..
            sub_parts = []
            for section_name, section_quota in q["sections"].items():
                section_color = AGY_SECTION_COLORS.get(section_name, color)
                sub_parts.append(
                    f"#[fg={section_color}]{section_name}#[default] "
                    f"{_fmt_quota(section_quota)}"
                )
            body = " ".join(sub_parts)
            parts.append(
                f"#[fg={color}]{NAMES[cli]}#[default] "
                f"#[fg={ind_color}]{sym}#[default] {body}"
            )
        else:
            # Standard provider: Name indicator quota
            parts.append(
                f"#[fg={color}]{NAMES[cli]}#[default] "
                f"#[fg={ind_color}]{sym}#[default] "
                f"{_fmt_quota(q)}"
            )

    return " | ".join(parts)


def main():
    now = time.time()
    print(_render(now))


if __name__ == "__main__":
    main()
