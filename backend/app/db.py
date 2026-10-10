"""Database wiring for the explicitly enabled legacy API."""
from pymongo import AsyncMongoClient

from app.config import settings

client = AsyncMongoClient(settings.mongodb_url, tz_aware=True, serverSelectionTimeoutMS=5000)
database = client[settings.mongodb_db_name]


def get_database():
    return database
