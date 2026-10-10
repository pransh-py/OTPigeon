"""Generate an exclusive local environment file; never replace existing state."""
import argparse
import os
import secrets
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / ".env")
    args = parser.parse_args()
    try:
        descriptor = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print(f"Keeping existing environment file: {args.output}")
        return
    with os.fdopen(descriptor, "w") as file:
        file.write(f"COMPOSE_PROJECT_NAME=otpigeon-{secrets.token_hex(4)}\n")
        file.write(f"OTPIGEON_SECRET={secrets.token_hex(32)}\nOTPIGEON_PORT=8000\n")
    print(f"Created local environment file: {args.output}")


if __name__ == "__main__":
    main()
