"""Country-independent formatting contracts shared with the JavaScript packages."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from otpigeon.gateway.management import TwilioSettings
from otpigeon.gateway.schemas import CreateChallenge
from otpigeon.schemas import OtpRequest, OtpVerificationRequest, SetSenderRequest

CASES = json.loads((Path(__file__).resolve().parents[2] / "tests/fixtures/phone-numbers.json").read_text())


def validate_every_boundary(number):
    values = [
        CreateChallenge(destination=number, purpose="signup").destination,
        OtpRequest(sender_phone=number, phone=number).phone,
        SetSenderRequest(sender_phone=number).sender_phone,
        OtpVerificationRequest(phone=number, otp="123456").phone,
        TwilioSettings(
            provider="twilio_sms", account_sid="AC" + "a" * 32, auth_token="fictional-test-token", from_number=number
        ).from_number,
    ]
    return values


@pytest.mark.parametrize("case", CASES["accepted"], ids=lambda c: c["label"])
def test_international_phone_is_preserved_across_boundaries(case):
    assert validate_every_boundary(case["number"]) == [case["number"]] * 5


@pytest.mark.parametrize("number", CASES["rejected"])
def test_noncanonical_phone_is_rejected_across_boundaries(number):
    validators = [
        lambda: CreateChallenge(destination=number, purpose="signup"),
        lambda: OtpRequest(sender_phone=number, phone=number),
        lambda: SetSenderRequest(sender_phone=number),
        lambda: OtpVerificationRequest(phone=number, otp="123456"),
        lambda: TwilioSettings(
            provider="twilio_sms", account_sid="AC" + "a" * 32, auth_token="fictional-test-token", from_number=number
        ),
    ]
    for validate in validators:
        with pytest.raises(ValidationError):
            validate()
