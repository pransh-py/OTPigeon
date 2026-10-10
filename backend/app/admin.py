"""Local operator commands. No HTTP administration surface is exposed."""
import argparse
import asyncio
import json

from pymongo import AsyncMongoClient

from app.gateway.config import GatewaySettings
from app.gateway.service import GatewayService


async def run(args):
    config = GatewaySettings.from_env()
    config.validate()
    async with AsyncMongoClient(config.mongodb_url, tz_aware=True, serverSelectionTimeoutMS=5000) as client:
        service = GatewayService(client[config.mongodb_db_name], config)
        await service.initialize()
        if args.command == "create-project":
            result = await service.create_project(args.name)
        elif args.command == "issue-key":
            result = await service.issue_key(args.project, args.environment)
        elif args.command == "list-keys":
            result = await service.list_keys(args.project)
        else:
            result = {"revoked": await service.revoke_key(args.key)}
        print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description="OTPigeon local administration")
    commands = parser.add_subparsers(dest="command", required=True)
    project = commands.add_parser("create-project")
    project.add_argument("--name", required=True)
    issue = commands.add_parser("issue-key")
    issue.add_argument("--project", required=True)
    issue.add_argument("--environment", choices=("test", "live"), required=True)
    listing = commands.add_parser("list-keys")
    listing.add_argument("--project", required=True)
    revoke = commands.add_parser("revoke-key")
    revoke.add_argument("--key", required=True)
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except ValueError as exc:
        parser.exit(2, f"{exc}\n")


if __name__ == "__main__":
    main()
