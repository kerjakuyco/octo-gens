"""Boot the frozen GUI with an isolated paper account; wait for the first quote."""

import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from contextlib import closing


def smoke(binary):
    with TemporaryDirectory() as folder:
        proc = subprocess.Popen([str(binary.resolve())], cwd=folder,
                                env={**os.environ, "OCTOGENS_DATA_DIR": folder})
        try:
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise RuntimeError(f"Desktop exited during startup: {proc.returncode}")
                # This book receives its first mark only after the real WebView
                # JavaScript has called the native bridge at startup.
                db = Path(folder) / "spot-usdt-sample.sqlite3"
                if db.exists():
                    with closing(sqlite3.connect(db, timeout=1)) as conn:
                        try:
                            row = conn.execute("SELECT price FROM marks WHERE book='DEMO' AND symbol='TSLAX/USDT'").fetchone()
                        except sqlite3.OperationalError:
                            row = None
                    if row and row[0] == "324.70":
                        print(f"Verified frozen desktop startup: {binary}")
                        return
                time.sleep(0.15)
            raise RuntimeError("Desktop did not load its initial practice quote")
        finally:
            if proc.poll() is None:
                proc.terminate()
            proc.wait(timeout=10)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = Path(sys.argv[1])
    elif sys.platform == "win32":
        target = next(Path("build").glob("exe.*/OctoGens.exe"))
    else:
        target = Path("build/Octo Gens.app/Contents/MacOS/OctoGens")
    smoke(target)
