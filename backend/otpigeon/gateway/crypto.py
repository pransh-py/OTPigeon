import base64
import hashlib
import hmac
import json

from cryptography.fernet import Fernet


class Vault:
    def __init__(self, secret):
        key = hmac.new(secret.encode(), b"otpigeon.encrypted-storage.v1", hashlib.sha256).digest()
        self.cipher = Fernet(base64.urlsafe_b64encode(key))

    def encrypt(self, value):
        return self.cipher.encrypt(json.dumps(value).encode()).decode()

    def decrypt(self, value):
        return json.loads(self.cipher.decrypt(value.encode()))
