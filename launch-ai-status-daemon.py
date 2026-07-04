#!/usr/bin/env python3
"""Launch the ai-status daemon detached from the calling process."""
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DAEMON = SCRIPT_DIR / "ai-status-daemon.py"


def _pythonw() -> Path:
    """Prefer pythonw.exe for a hidden console on Windows."""
    exe = Path(sys.executable)
    pythonw = exe.with_name("pythonw.exe")
    if pythonw.exists():
        return pythonw
    return exe


def main():
    socket_path = sys.argv[1] if len(sys.argv) > 1 else None
    env = os.environ.copy()
    if socket_path:
        env["PSMUX_SOCKET"] = socket_path

    # Use DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP so the daemon outlives
    # the run-shell invocation and doesn't steal the psmux console.
    creationflags = (
        subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    )
    subprocess.Popen(
        [str(_pythonw()), str(DAEMON)],
        cwd=str(SCRIPT_DIR),
        env=env,
        creationflags=creationflags,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        close_fds=True,
    )


if __name__ == "__main__":
    main()
