from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from typing import Literal


class TwilioSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["twilio_sms"]
    account_sid: str = Field(pattern=r"^AC[0-9a-fA-F]{32}$")
    auth_token: str = Field(min_length=16, max_length=256)
    from_number: str = Field(pattern=r"^\+[1-9][0-9]{7,14}$")


class MetaSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: Literal["meta_whatsapp"]
    phone_number_id: str = Field(pattern=r"^[0-9]{5,32}$")
    api_version: str = Field(pattern=r"^v[0-9]{1,3}\.[0-9]{1,2}$")
    access_token: str = Field(min_length=16, max_length=2048)
    app_secret: str = Field(min_length=16, max_length=256)
    verify_token: str = Field(min_length=16, max_length=256)
    template_name: str = Field(pattern=r"^[a-z0-9_]{1,512}$")
    language: str = Field(pattern=r"^[a-z]{2,3}(?:_[A-Z]{2})?$")


class ProjectManagement:
    async def configure_provider(self, project_id, environment, config):
        if environment != "live":
            raise ValueError("Test environments always use the mock provider")
        try:
            model = {"twilio_sms": TwilioSettings, "meta_whatsapp": MetaSettings}[config.get("provider")]
            value = model.model_validate(config).model_dump()
        except (ValidationError, KeyError, TypeError, AttributeError):
            raise ValueError("Invalid provider configuration; check the documented required fields") from None
        return await self._replace_provider(
            project_id,
            {
                "provider": value["provider"],
                "revision": uuid4().hex,
                "sealed": self.vault.encrypt(value),
                "updated_at": self.clock(),
            },
        )

    async def disable_provider(self, project_id):
        return await self._replace_provider(
            project_id, {"provider": None, "revision": uuid4().hex, "updated_at": self.clock()}
        )

    async def _replace_provider(self, project_id, provider):
        from .service import identifier

        gate = identifier(project_id, "live")
        await self._ensure_gate(gate)

        async def transaction(session):
            # Serialize configuration changes against the worker's final dispatch check.
            await self.db.gates.update_one({"_id": gate}, {"$inc": {"revision": 1}}, session=session)
            result = await self.db.projects.update_one(
                {"_id": project_id}, {"$set": {"environments.live": provider}}, session=session
            )
            if not result.matched_count:
                raise ValueError("Project not found")

        await self._transaction(transaction)
        return await self.project_detail(project_id)

    async def project_detail(self, project_id):
        document = await self.db.projects.find_one({"_id": project_id})
        if not document:
            raise ValueError("Project not found")
        environments = {}
        for name, env in document["environments"].items():
            environments[name] = {"provider": env["provider"], "configured": bool(env["provider"])}
            if env.get("sealed"):
                config = self.vault.decrypt(env["sealed"])
                safe = ("template_name", "language", "api_version")
                environments[name]["settings"] = {k: config[k] for k in safe if k in config}
        return {"project_id": document["_id"], "name": document["name"], "environments": environments}

    async def list_projects(self):
        documents = await self.db.projects.find({}, {"_id": 1}).sort("created_at", -1).limit(200).to_list(None)
        return [await self.project_detail(d["_id"]) for d in documents]

    async def list_challenges(self, actor, *, before=None, status=None, limit=50):
        import base64
        import json
        from datetime import datetime

        query = {"project_id": actor["project_id"], "environment": actor["environment"]}
        conditions = []
        if before:
            try:
                if len(before) > 256:
                    raise ValueError
                stamp, last_id = json.loads(base64.urlsafe_b64decode(before + "=" * (-len(before) % 4)))
                stamp = datetime.fromisoformat(stamp)
                if not stamp.tzinfo or not isinstance(last_id, str) or len(last_id) != 32:
                    raise ValueError
            except (ValueError, TypeError, UnicodeError):
                raise ValueError("Invalid pagination cursor") from None
            conditions.append({"$or": [{"created_at": {"$lt": stamp}}, {"created_at": stamp, "_id": {"$lt": last_id}}]})
        now = self.clock()
        if status == "expired":
            conditions.append({"$or": [{"status": "expired"}, {"status": "pending", "expires_at": {"$lte": now}}]})
        elif status == "pending":
            query.update(status="pending", expires_at={"$gt": now})
        elif status:
            query["status"] = status
        if conditions:
            query["$and"] = conditions
        documents = (
            await self.db.challenges.find(query).sort([("created_at", -1), ("_id", -1)]).limit(limit + 1).to_list(None)
        )
        items = []
        for document in documents[:limit]:
            result = await self.execute(actor, "get", challenge_id=document["_id"])
            if result[0] == 200:
                items.append(result[1])
        cursor = None
        if len(documents) > limit:
            last = documents[limit - 1]
            cursor = (
                base64.urlsafe_b64encode(json.dumps([last["created_at"].isoformat(), last["_id"]]).encode())
                .decode()
                .rstrip("=")
            )
        return {"items": items, "next_cursor": cursor}
