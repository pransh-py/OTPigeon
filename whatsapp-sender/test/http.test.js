const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createServer } = require('node:net');
const { randomBytes } = require('node:crypto');

test('sender refuses public defaults and protects status without loading a WhatsApp session', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'otpigeon-sender-test-'));
  const entry = resolve(__dirname, '../src/index.js');
  const env = { ...process.env };
  delete env.SENDER_API_KEY;
  delete env.HOST;
  try {
    const missing = spawn(process.execPath, [entry], { cwd, env, stdio: 'pipe' });
    assert.notEqual((await once(missing, 'exit'))[0], 0);
    const allocator = createServer();
    allocator.listen(0, '127.0.0.1');
    await once(allocator, 'listening');
    const port = allocator.address().port;
    await new Promise(resolve => allocator.close(resolve));
    const key = randomBytes(32).toString('hex');
    const child = spawn(process.execPath, [entry], { cwd, env: { ...env, PORT: String(port), SENDER_API_KEY: key }, stdio: 'pipe' });
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('sender did not start')), 10000);
        child.stdout.on('data', chunk => {
          if (chunk.toString().includes('listening')) { clearTimeout(timeout); resolve(); }
        });
        child.on('exit', () => { clearTimeout(timeout); reject(new Error('sender exited early')); });
      });
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${base}/status`)).status, 401);
      assert.equal((await fetch(`${base}/status`, { headers: { 'X-SENDER-API-KEY': 'local-dev-key' } })).status, 401);
      const status = await fetch(`${base}/status`, { headers: { 'X-SENDER-API-KEY': key } });
      assert.equal(status.status, 200);
      const body = await status.json();
      assert.equal(body.loadedSenderCount, 0);
      assert.deepEqual(body.senders, []);
      const cases = require('../../tests/fixtures/phone-numbers.json');
      const headers = { 'X-SENDER-API-KEY': key, 'Content-Type': 'application/json' };
      for (const {number} of cases.accepted) {
        const response = await fetch(`${base}/senders/normalize`, {method: 'POST', headers, body: JSON.stringify({sender_phone: number})});
        assert.equal(response.status, 200);
        assert.equal((await response.json()).senderId, number.slice(1));
      }
      for (const number of cases.rejected) {
        const response = await fetch(`${base}/senders/normalize`, {method: 'POST', headers, body: JSON.stringify({sender_phone: number})});
        assert.equal(response.status, 400);
      }
      // A short sender ID passes syntax validation and reaches the missing-session
      // check. No WhatsApp account is created, linked, or contacted.
      const missingSender = await fetch(`${base}/send-otp`, {method: 'POST', headers,
        body: JSON.stringify({sender_id: '6834002', phone: '+6834002', otp: '123456'})});
      assert.equal(missingSender.status, 404);
      assert.equal((await missingSender.json()).error, 'sender_not_found');
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
