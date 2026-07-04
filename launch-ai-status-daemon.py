#!/usr/bin/env python3
"""Launch the ai-status daemon detached from the calling process."""
import os
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DAEMON = SCRIPT_DIR / "ai-status-daemon.py"


def _daemon_python() -> Path:
    """Return the Python interpreter to use for the daemon.

    pythonw.exe avoids a console window, but on some Windows setups it is
    terminated when launched from tmux/psmux run-shell. We use python3.exe
    with CREATE_NO_WINDOW instead so the daemon survives and stays hidden.
    """
    exe = Path(sys.executable)
    # Prefer the regular console python binary over pythonw for stability.
    python3 = exe.with_name("python3.exe")
    if python3.exists():
        return python3
    return exe


def main():
    socket_path = sys.argv[1] if len(sys.argv) > 1 else None
    env = os.environ.copy()
    if socket_path:
        env["PSMUX_SOCKET"] = socket_path

    # DETACHED_PROCESS + CREATE_NEW_PROCESS_GROUP lets the daemon outlive the
    # run-shell invocation; CREATE_NO_WINDOW keeps it from flashing a console.
    creationflags = (
        subprocess.DETACHED_PROCESS
        | subprocess.CREATE_NEW_PROCESS_GROUP
        | subprocess.CREATE_NO_WINDOW
    )
    subprocess.Popen(
        [str(_daemon_python()), str(DAEMON)],
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
