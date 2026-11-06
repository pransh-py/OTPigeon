"""One entry point for installation, serving, workers, and local administration."""

import argparse
import asyncio
import json
import os
import secrets
from pathlib import Path


def initialize(output):
    # Exclusive creation also protects existing deployments from accidental re-keying.
    try:
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print(f"Keeping existing environment file: {output}")
        return
    with os.fdopen(fd, "w") as file:
        file.write(f"COMPOSE_PROJECT_NAME=otpigeon-{secrets.token_hex(4)}\n")
        file.write(f"OTPIGEON_SECRET={secrets.token_hex(32)}\n")
        file.write(f"OTPIGEON_ADMIN_TOKEN={secrets.token_hex(32)}\n")
        file.write("OTPIGEON_PORT=8000\nOTPIGEON_PUBLIC_BASE_URL=http://localhost:8000\n")
        file.write("OTPIGEON_ALLOW_LIVE_DELIVERY=false\nOTPIGEON_DISPATCH_MOCK=true\n")
    print(f"Created environment file: {output}. Keep it private and back it up with your database.")


async def maintenance(apply):
    from pymongo import AsyncMongoClient
    from otpigeon.gateway.config import GatewaySettings
    from otpigeon.gateway.service import GatewayService
    from otpigeon.maintenance import prune

    config = GatewaySettings.from_env()
    config.validate()
    async with AsyncMongoClient(config.mongodb_url, tz_aware=True, serverSelectionTimeoutMS=5000) as client:
        service = GatewayService(client[config.mongodb_db_name], config)
        await service.initialize()
        print(json.dumps(await prune(service, apply=apply)))


def main():
    parser = argparse.ArgumentParser(prog="otpigeon", description="Self-hosted verification gateway")
    parser.add_argument("--version", action="version", version="OTPigeon 0.2.0rc1")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Generate a private .env without replacing existing files")
    init.add_argument("--output", type=Path, default=Path(".env"))
    serve = commands.add_parser("serve", help="Run the API and dashboard")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--workers", type=int, default=1)
    worker = commands.add_parser("worker", help="Dispatch durable delivery jobs")
    worker.add_argument("--once", action="store_true")
    prune = commands.add_parser("prune", help="Preview retention cleanup; --apply performs deletion")
    prune.add_argument("--apply", action="store_true")
    admin = commands.add_parser("admin", help="Local project/key administration")
    admin.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        if args.command == "init":
            initialize(args.output)
        elif args.command == "serve":
            import uvicorn

            # Verify tokens can occur in webhook query strings; don't write them to access logs.
            uvicorn.run(
                "otpigeon.main:app",
                host=args.host,
                port=args.port,
                workers=args.workers,
                access_log=False,
                proxy_headers=False,
                server_header=False,
            )
        elif args.command == "worker":
            from otpigeon.worker import run_worker

            asyncio.run(run_worker(once=args.once))
        elif args.command == "prune":
            asyncio.run(maintenance(args.apply))
        else:
            from otpigeon.admin import main as admin_main

            admin_main(args.arguments)
    except (ValueError, OSError) as exc:
        parser.exit(2, f"{exc}\n")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
