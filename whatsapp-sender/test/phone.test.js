const {test} = require('node:test');
const assert = require('node:assert/strict');
const cases = require('../../tests/fixtures/phone-numbers.json');
const {isValidE164Phone, toWhatsAppLookupNumber} = require('../src/phone');

for (const {label, number} of cases.accepted) {
  test(`international format: ${label}`, () => {
    assert.equal(isValidE164Phone(number), true);
    assert.equal(toWhatsAppLookupNumber(number), number.slice(1));
  });
}
for (const [index, number] of cases.rejected.entries()) {
  test(`reject noncanonical input ${index}`, () => assert.equal(isValidE164Phone(number), false));
}
