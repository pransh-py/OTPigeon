"""Explicit retention maintenance. Pending challenges and in-flight jobs are preserved."""

from datetime import timedelta


async def prune(service, *, apply=False):
    cutoff = service.clock() - timedelta(days=service.config.history_retention_days)
    # Terminal state alone is insufficient: wait for the original validity window
    # and retained history window before deleting delivery correlation records.
    query = {"status": {"$ne": "pending"}, "expires_at": {"$lt": cutoff}}
    count = 0
    async for challenge in service.db.challenges.find(query):
        active = await service.db.jobs.count_documents(
            {"challenge_id": challenge["_id"], "state": {"$in": ["queued", "leased", "sending"]}}
        )
        if active:
            continue
        count += 1
        if apply:
            await service.db.events.delete_many({"challenge_id": challenge["_id"]})
            await service.db.jobs.delete_many({"challenge_id": challenge["_id"]})
            await service.db.outbox.delete_many({"_id": challenge["_id"]})
            await service.db.challenges.delete_one({"_id": challenge["_id"]})
    if apply:
        await service.db.budgets.delete_many(
            {"sends": {"$not": {"$elemMatch": {"$gt": cutoff}}}, "guesses": {"$not": {"$elemMatch": {"$gt": cutoff}}}}
        )
        await service.db.events.delete_many({"challenge_id": None, "timestamp": {"$lt": cutoff}})
    return {"eligible_challenges": count, "applied": apply, "cutoff": cutoff.isoformat()}
