import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../src/app/api/repository-agent/route';

test('simultaneously completed request bodies cannot bypass the bridge concurrency limit', async () => {
  const names = ['HOOSPEC_PAGES_ORIGIN', 'HOOSPEC_REPOSITORY_AGENT_TOKEN', 'HOOSPEC_AI_KEY', 'HOOSPEC_AI_MODEL'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const fetchBefore = globalThis.fetch;
  const token = 'test-only-bridge-concurrency-token-long-enough';
  Object.assign(process.env, { HOOSPEC_PAGES_ORIGIN: 'https://pages.test', HOOSPEC_REPOSITORY_AGENT_TOKEN: token, HOOSPEC_AI_KEY: 'test-only-key', HOOSPEC_AI_MODEL: 'fixture' });
  let providerRequests = 0;
  globalThis.fetch = async (_url, init) => {
    providerRequests++;
    const signal = init!.signal!;
    return new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.close(), { once: true }); } }));
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const payload = new TextEncoder().encode(JSON.stringify({ filename: 'checkout.feature', source: 'Feature: Checkout\n  Scenario: Pay\n    Given a card\n', nodeId: 'step:3', instruction: 'Improve', actor: 'test' }));
  const requests = Array.from({ length: 5 }, () => new Request('https://agent.test/api/repository-agent', { method: 'POST', headers: { Origin: 'https://pages.test', Authorization: 'Bearer ' + token }, body: new ReadableStream({ async start(controller) { await gate; controller.enqueue(payload); controller.close(); } }), duplex: 'half' } as RequestInit));
  const responses: Response[] = [];
  try {
    const pending = requests.map(request => POST(request)); release(); responses.push(...await Promise.all(pending));
    assert.equal(responses.filter(response => response.status === 200).length, 4);
    assert.equal(responses.filter(response => response.status === 429).length, 1);
    assert.equal(providerRequests, 4);
  } finally {
    await Promise.all(responses.map(response => response.body?.cancel()));
    // Let aborted provider readers and slot cleanup finish before restoring the fixture.
    await new Promise(resolve => setTimeout(resolve, 0));
    globalThis.fetch = fetchBefore;
    for (const name of names) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; }
  }
});
