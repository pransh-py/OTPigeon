// Run after creating a project and test key. No provider messages or real users.
import {OTPigeon} from '../sdk/index.js';
import {randomUUID, randomBytes} from 'node:crypto';
const apiKey = process.env.OTPIGEON_API_KEY || '';
if (!apiKey.startsWith('otpg_test_')) throw new Error('Set OTPIGEON_API_KEY to a project test key');
const gateway = new OTPigeon({baseUrl: process.env.OTPIGEON_BASE_URL || 'http://localhost:8000', apiKey});
const expected = {destination: process.env.OTPIGEON_DESTINATION || '+15555550123', purpose: 'signup'};
const challenge = await gateway.create(expected, {idempotencyKey: randomUUID()});
// A real app keeps these values in its own server-side pending login record.
const pending = {...expected, challenge_id: challenge.challenge_id, project_id: challenge.project_id, environment: 'test'};
let received;
for (let i = 0; i < 100; i++) {
  try { received = await gateway.testCode(challenge.challenge_id); break; }
  catch (e) { if (e.status !== 404) throw e; await new Promise(resolve => setTimeout(resolve, 100)); }
}
if (!received) throw new Error('Test delivery did not complete; is the worker running?');
const verified = await gateway.verify(challenge.challenge_id, received.code);
if (!verified.verified || Object.entries(pending).some(([key, value]) => verified[key] !== value)) throw new Error('Verification did not match this application flow');
const applicationSession = {userId: 'fictional-demo-user', id: randomBytes(32).toString('hex')};
const history = await gateway.events({challengeId: challenge.challenge_id});
console.log(JSON.stringify({challenge_id: challenge.challenge_id, verified: true, simulated: true,
  application_session_created: Boolean(applicationSession), events: history.items.map(e => e.type)}, null, 2));
