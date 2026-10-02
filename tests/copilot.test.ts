import test from 'node:test';
import assert from 'node:assert/strict';
import { CopilotBroker } from '../src/lib/copilot-broker';
import { CopilotConnection, copilotUrl } from '../src/lib/copilot-connection';
import type { CopilotRuntime } from '../src/lib/copilot-runtime';

const models = [{ id: 'fixture-model', name: 'Fixture model' }];
function fixture() {
  let clock = 0;
  const replies: Record<string, unknown>[] = [];
  const requests: {url: string; body: Record<string, string>}[] = [];
  const runtime: CopilotRuntime = { async models(token) { assert.equal(token, 'gho_fixture'); return models; }, async generate(token, model, _messages, delta, signal) { assert.equal(token, 'gho_fixture'); assert.equal(model, 'fixture-model'); signal.throwIfAborted(); delta('Feature: Updated\n'); return 'Feature: Updated\n'; } };
  const broker = new CopilotBroker(runtime, async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body)) }); assert.equal(init?.redirect, 'error'); return Response.json(replies.shift() || {}); }, () => clock);
  async function start() { replies.push({ device_code: 'private-device-code', user_code: 'TEAM-TEST', interval: 5, expires_in: 900 }); return broker.start('own-public-app'); }
  async function connected() { const pending = await start(); clock += 5000; replies.push({ access_token: 'gho_fixture' }); return await broker.poll(pending.session, 'own-public-app'); }
  return { broker, start, connected, requests, replies, runtime, advance(ms: number) { clock += ms; } };
}
test('Copilot device login uses own app and returns only a user code and opaque credential', async () => {
  const f = fixture(), pending = await f.start();
  assert.equal(f.requests[0].body.client_id, 'own-public-app'); assert.equal(f.requests[0].body.scope, 'read:user');
  assert.ok(!JSON.stringify(pending).includes('private-device-code')); assert.match(pending.session, /^[a-f0-9]{64}$/);
  assert.equal(pending.verificationUrl, 'https://github.com/login/device');
  await assert.rejects(f.broker.start(''), /HOOSPEC_COPILOT_CLIENT_ID/);
});
test('device polling enforces provider intervals, handles slow_down and never exposes GitHub tokens', async () => {
  const f = fixture(), pending = await f.start();
  assert.equal((await f.broker.poll(pending.session, 'own-public-app')).status, 'pending'); assert.equal(f.requests.length, 1);
  f.advance(5000); f.replies.push({ error: 'slow_down' }); assert.equal((await f.broker.poll(pending.session, 'own-public-app')).interval, 10);
  f.advance(10000); f.replies.push({ access_token: 'gho_fixture' }); const connected = await f.broker.poll(pending.session, 'own-public-app');
  assert.equal(connected.status, 'connected'); assert.notEqual(connected.session, pending.session); assert.deepEqual(connected.models, models); assert.ok(!JSON.stringify(connected).includes('gho_fixture'));
  await assert.rejects(f.broker.poll(pending.session, 'own-public-app'), /abgelaufen/);
});
test('expired and refused device flows cannot become connected', async () => {
  const f = fixture(), pending = await f.start(); f.advance(900001); await assert.rejects(f.broker.poll(pending.session, 'app'), /abgelaufen/);
  const other = await f.start(); f.advance(5000); f.replies.push({ error: 'access_denied', error_description: 'private upstream detail' });
  await assert.rejects(f.broker.poll(other.session, 'app'), error => error instanceof Error && !error.message.includes('private upstream'));
});
test('disconnect during entitlement lookup cannot resurrect a cancelled OAuth session', async () => {
  const f = fixture(), pending = await f.start(); let finish!: () => void;
  f.runtime.models = () => new Promise(resolve => { finish = () => resolve(models); });
  f.advance(5000); f.replies.push({ access_token: 'gho_fixture' }); const operation = f.broker.poll(pending.session, 'app');
  await new Promise(resolve => setImmediate(resolve)); f.broker.disconnect(pending.session); finish(); await assert.rejects(operation, /beendet/);
});
test('Copilot uses the authenticated user and enforces selected models and session lifetime', async () => {
  const f = fixture(), result = await f.connected(); assert.ok(result.session); let output = '';
  assert.equal(await f.broker.generate(result.session!, 'fixture-model', [], text => { output += text; }, new AbortController().signal), 'Feature: Updated\n'); assert.equal(output, 'Feature: Updated\n');
  await assert.rejects(f.broker.generate(result.session!, 'unknown', [], () => {}, new AbortController().signal), /freigegeben/);
  f.advance(3600001); await assert.rejects(f.broker.generate(result.session!, 'fixture-model', [], () => {}, new AbortController().signal), /abgelaufen/);
});
test('disconnect cancels in-flight Copilot generation and prevents further requests', async () => {
  const f = fixture(), result = await f.connected();
  f.runtime.generate = (_token, _model, _messages, _delta, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
  const operation = f.broker.generate(result.session!, 'fixture-model', [], () => {}, new AbortController().signal);
  await assert.rejects(f.broker.generate(result.session!, 'fixture-model', [], () => {}, new AbortController().signal), /bereits/);
  f.broker.disconnect(result.session!); await assert.rejects(operation, /aborted/); assert.throws(() => f.broker.authorize(result.session!, 'fixture-model'), /abgelaufen/);
});
test('browser Copilot connection rejects unsafe URLs and only transmits its opaque session', async () => {
  for (const url of ['http://external.test/api/copilot', 'https://secret@relay.test', 'https://relay.test?token=secret']) assert.throws(() => copilotUrl(url));
  const credential = 'a'.repeat(64), authenticated = 'b'.repeat(64); let calls = 0;
  const connection = new CopilotConnection('https://relay.test/api/copilot', async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const headers = init?.headers as Record<string, string>;
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error'); calls++;
    if (body.action === 'start') { assert.equal(headers.Authorization, undefined); return Response.json({ session: credential, userCode: 'TEAM-TEST', verificationUrl: 'https://github.com/login/device', interval: 5, expiresIn: 900 }); }
    if (body.action === 'poll') { assert.equal(headers.Authorization, `Bearer ${credential}`); return Response.json({ status: 'connected', session: authenticated, models }); }
    assert.equal(headers.Authorization, `Bearer ${authenticated}`);
    if (body.action === 'agent') { assert.equal(body.model, 'fixture-model'); return Response.json({ error: 'Expired' }, { status: 401 }); }
    return Response.json({ disconnected: true });
  });
  await connection.start(); await connection.poll(); assert.equal(connection.connected, true);
  assert.equal((await connection.agent({ instruction: 'Improve' })).status, 401); assert.equal(connection.connected, false); assert.ok(calls >= 3);
});
test('browser rejects a forged verification destination and never persists login credentials', async () => {
  const connection = new CopilotConnection('https://relay.test/api/copilot', async () => Response.json({ session: 'a'.repeat(64), userCode: 'TEST', verificationUrl: 'https://evil.test' }));
  await assert.rejects(connection.start(), /Ungültige/); assert.equal(connection.connected, false);
});

test('Copilot relay restricts origins, rejects unauthenticated inference and contains no provider credentials', async () => {
  const { POST, OPTIONS } = await import('../src/app/api/copilot/route');
  const previous = process.env.HOOSPEC_PAGES_ORIGIN, clientId = process.env.HOOSPEC_COPILOT_CLIENT_ID;
  process.env.HOOSPEC_PAGES_ORIGIN = 'https://studio.test'; delete process.env.HOOSPEC_COPILOT_CLIENT_ID;
  try {
    const request = (origin: string, body: object) => new Request('https://relay.test/api/copilot', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await POST(request('https://foreign.test', { action: 'start' }))).status, 403);
    assert.equal(OPTIONS(new Request('https://relay.test/api/copilot', { method: 'OPTIONS', headers: { Origin: 'https://studio.test' } })).status, 204);
    const missing = await POST(request('https://studio.test', { action: 'start' })); assert.equal(missing.status, 503); assert.match(await missing.text(), /HOOSPEC_COPILOT_CLIENT_ID/); assert.equal(missing.headers.get('Cache-Control'), 'no-store');
    assert.equal((await POST(request('https://studio.test', { action: 'agent' }))).status, 401);
  } finally { if (previous === undefined) delete process.env.HOOSPEC_PAGES_ORIGIN; else process.env.HOOSPEC_PAGES_ORIGIN = previous; if (clientId === undefined) delete process.env.HOOSPEC_COPILOT_CLIENT_ID; else process.env.HOOSPEC_COPILOT_CLIENT_ID = clientId; }
});
