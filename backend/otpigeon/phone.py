"""Canonical international phone syntax, without a default country.

This bounds the wire format; it does not establish that a number is assigned,
reachable, registered with WhatsApp, or valid under a country's numbering plan.
"""

E164_PHONE_PATTERN = r"^\+[1-9][0-9]{1,14}$"
