import {randomUUID} from 'node:crypto';

export class OTPigeonError extends Error {
  constructor(message, {status = 0, code = 'network_error', retryAfter = null, idempotencyKey, cause} = {}) {
    super(message, {cause}); this.name = 'OTPigeonError'; this.status = status; this.code = code;
    this.retryAfter = retryAfter; this.idempotencyKey = idempotencyKey;
  }
}

/** Server-side only. Never place application keys in browser bundles. */
export class OTPigeon {
  constructor({baseUrl, apiKey, timeoutMs = 10000, fetch: transport = globalThis.fetch}) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new TypeError('baseUrl must be an HTTP(S) origin');
    if (typeof apiKey !== 'string' || !apiKey.startsWith('otpg_')) throw new TypeError('A server-side OTPigeon API key is required');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive');
    this.baseUrl = url.origin; this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.fetch = transport;
  }
  async request(method, path, body, idempotencyKey) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) throw new TypeError('Invalid idempotency key');
    let response;
    try {
      response = await this.fetch(this.baseUrl + path, {method, redirect: 'error',
        headers: {'Authorization': 'Bearer ' + this.apiKey, ...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {})},
        ...(body !== undefined ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(this.timeoutMs)});
    } catch (cause) { throw new OTPigeonError('Could not reach the verification gateway', {idempotencyKey, cause}); }
    let data;
    try { data = await response.json(); } catch (cause) { throw new OTPigeonError('Gateway returned an invalid response', {status: response.status, code: 'invalid_response', idempotencyKey, cause}); }
    if (!response.ok) {
      const retry = response.headers.get('Retry-After');
      throw new OTPigeonError(data.error?.message || 'Gateway request failed', {status: response.status, code: data.error?.code || 'gateway_error', retryAfter: retry && /^\d+$/.test(retry) ? Number(retry) : null, idempotencyKey});
    }
    return data;
  }
  create(body, {idempotencyKey = randomUUID()} = {}) { return this.request('POST', '/v1/challenges', body, idempotencyKey); }
  get(challengeId) { return this.request('GET', '/v1/challenges/' + encodeURIComponent(challengeId)); }
  resend(challengeId, {idempotencyKey = randomUUID()} = {}) { return this.request('POST', '/v1/challenges/' + encodeURIComponent(challengeId) + '/resend', {}, idempotencyKey); }
  verify(challengeId, code) { return this.request('POST', '/v1/challenges/' + encodeURIComponent(challengeId) + '/verify', {code}); }
  events({challengeId, after = 0, limit = 50} = {}) { const q = new URLSearchParams({after, limit}); if (challengeId) q.set('challenge_id', challengeId); return this.request('GET', '/v1/events?' + q); }
  list({before, status, limit = 50} = {}) { const q = new URLSearchParams({limit}); if (before) q.set('before', before); if (status) q.set('status', status); return this.request('GET', '/v1/challenges?' + q); }
  testCode(challengeId) { return this.request('GET', '/v1/test/outbox?' + new URLSearchParams({challenge_id: challengeId})); }
}
