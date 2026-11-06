import test from 'node:test';
import assert from 'node:assert/strict';
import {OTPigeon, OTPigeonError} from '../index.js';
const options = {baseUrl: 'https://gateway.test', apiKey: 'otpg_test_fictional'};
test('propagates scope payload and stable idempotency without automatic retries', async () => {
 const calls = []; const sdk = new OTPigeon({...options, fetch: async (...args) => { calls.push(args); return Response.json({challenge_id: 'abc'}); }});
 await sdk.create({destination: '+15555550123', purpose: 'signup'}, {idempotencyKey: 'stable.1'});
 assert.equal(calls.length, 1); const [url, init] = calls[0]; assert.equal(url, 'https://gateway.test/v1/challenges');
 assert.equal(init.headers['Idempotency-Key'], 'stable.1'); assert.equal(init.redirect, 'error'); assert.equal(JSON.parse(init.body).purpose, 'signup');
 await sdk.verify('a/b', '123456'); assert.ok(calls[1][0].includes('a%2Fb/verify'));
});
test('typed errors preserve safe retry metadata and no request payload', async () => {
 const sdk = new OTPigeon({...options, fetch: async () => Response.json({error: {code: 'cooldown', message: 'Wait'}}, {status: 429, headers: {'Retry-After': '9'}})});
 await assert.rejects(sdk.resend('abc', {idempotencyKey: 'stable'}), e => e instanceof OTPigeonError && e.status === 429 && e.retryAfter === 9 && e.idempotencyKey === 'stable');
});
test('network uncertainty returns idempotency key and never resends automatically', async () => {
 let attempts = 0; const sdk = new OTPigeon({...options, fetch: async () => { attempts++; throw new TypeError('offline'); }});
 await assert.rejects(sdk.create({destination: '+15555550123', purpose: 'signup'}), e => e.status === 0 && typeof e.idempotencyKey === 'string'); assert.equal(attempts, 1);
});
test('rejects non-origin URLs, invalid timeouts, and invalid idempotency keys', async () => {
 for (const baseUrl of ['https://u:p@gateway.test', 'https://gateway.test/path', 'file:///tmp']) assert.throws(() => new OTPigeon({...options, baseUrl}));
 assert.throws(() => new OTPigeon({...options, timeoutMs: -1}));
 await assert.rejects(new OTPigeon(options).create({}, {idempotencyKey: 'bad\nkey'}), TypeError);
});
