"""Generate a private Compose environment without requiring a Python installation of OTPigeon."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from otpigeon.cli import main

if __name__ == "__main__":
    main_args = ["init", *sys.argv[1:]]
    sys.argv = [sys.argv[0], *main_args]
    main()
