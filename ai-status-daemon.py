#!/usr/bin/env python3
"""Background daemon for tmux-agent-status.

Refreshes the tmux/psmux status-right with a compact AI-provider segment.
Works around tmux's unsupported #(...) substitution by polling the status
script and updating the option directly.
"""
import atexit
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import psutil

SCRIPT_DIR = Path(__file__).resolve().parent


def _home_dir() -> Path:
    """Resolve the user's home directory robustly."""
    home = os.environ.get("USERPROFILE") or os.environ.get("HOME")
    if home:
        return Path(home)
    if SCRIPT_DIR.name == "ai-status" and SCRIPT_DIR.parent.name == ".tmux":
        return SCRIPT_DIR.parent.parent
    return SCRIPT_DIR.parent


HOME_DIR = _home_dir()
STATUS_SCRIPT = SCRIPT_DIR / "ai-status.py"
LOCK_FILE = SCRIPT_DIR / "daemon.lock"

# Full path to the tmux/psmux binary. Set PSMUX_BIN if it is not on PATH.
PSMUX_BIN = Path(os.environ.get("PSMUX_BIN", "psmux"))
PSMUX_SOCKET = os.environ.get("PSMUX_SOCKET")

INTERVAL = 15  # seconds


def _running():
    """Return True if a daemon lock points to a live process."""
    if not LOCK_FILE.exists():
        return False
    try:
        pid = int(LOCK_FILE.read_text().strip())
    except Exception:
        return False
    return pid != os.getpid() and psutil.pid_exists(pid)


def _clear_lock():
    try:
        if LOCK_FILE.exists():
            current = LOCK_FILE.read_text().strip()
            if current == str(os.getpid()):
                LOCK_FILE.unlink()
    except Exception:
        pass


def _psmux_server_alive() -> bool:
    """Check if the target psmux server is still running."""
    cmd = [str(PSMUX_BIN)]
    if PSMUX_SOCKET:
        cmd.extend(["-S", PSMUX_SOCKET])
    cmd.append("list-sessions")
    try:
        result = subprocess.run(
            cmd,
            cwd=str(HOME_DIR),
            timeout=5,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return result.returncode == 0
    except Exception:
        pass
    return False


def _get_status() -> str:
    output = subprocess.check_output(
        [sys.executable, str(STATUS_SCRIPT)],
        cwd=str(HOME_DIR),
        stderr=subprocess.STDOUT,
        timeout=30,
    )
    return output.decode("utf-8", errors="replace").strip()


def _update_status():
    try:
        status = _get_status()
    except subprocess.TimeoutExpired:
        status = "AI timeout"
    except Exception as e:
        status = f"AI err"

    # Match the Tokyo Night clock/date suffix from the theme.
    suffix = (
        " #[fg=#292e42,bg=#1a1b26]▐"
        "#[bg=#292e42,fg=#7dcfff] %H:%M:%S "
        "#[fg=#7aa2f7,bg=#292e42]▐"
        "#[bg=#7aa2f7,fg=#16161e,bold] %a %d-%b "
    )
    status_right = f"{status}{suffix}"

    cmd = [str(PSMUX_BIN)]
    if PSMUX_SOCKET:
        cmd.extend(["-S", PSMUX_SOCKET])
    cmd.extend(["set", "-g", "status-right", status_right])
    subprocess.run(
        cmd,
        cwd=str(HOME_DIR),
        timeout=30,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main():
    if _running():
        print("ai-status-daemon already running")
        return

    LOCK_FILE.write_text(str(os.getpid()))
    atexit.register(_clear_lock)

    def _shutdown(signum, frame):
        _clear_lock()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    # Give psmux a moment to finish sourcing the config.
    time.sleep(1)

    while True:
        if not _psmux_server_alive():
            break
        _update_status()
        time.sleep(INTERVAL)

    _clear_lock()


if __name__ == "__main__":
    main()
