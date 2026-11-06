from dataclasses import dataclass


@dataclass(frozen=True)
class DeliveryResult:
    status: str = "provider_accepted"
    reason: str | None = None


class MockDelivery:
    def prepare(self) -> DeliveryResult:
        # Pure preparation: transaction retries must never perform a network send.
        # Real adapters will need a durable dispatch worker in a later milestone.
        return DeliveryResult()
