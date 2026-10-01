import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyOf, readRequestText } from '../src/lib/http';

function streamed(chunks: Uint8Array[], onCancel?: () => void) {
  return new Request('http://localhost/api/workspace', {
    method: 'POST',
    body: new ReadableStream({ pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()!); else controller.close(); }, cancel: onCancel }),
    // Node requires duplex for streamed request bodies.
    duplex: 'half',
  } as RequestInit);
}
test('request limits count UTF-8 bytes, stop oversized streams and tolerate split characters', async () => {
  const bytes = new TextEncoder().encode('Grüße');
  assert.equal(await readRequestText(streamed([bytes.slice(0, 3), bytes.slice(3)]), bytes.length), 'Grüße');
  let cancelled = false;
  await assert.rejects(readRequestText(streamed([bytes, bytes, bytes], () => { cancelled = true; }), bytes.length), error => error instanceof Error && 'status' in error && error.status === 413);
  assert.equal(cancelled, true);
  await assert.rejects(readRequestText(new Request('http://localhost', { method: 'POST', headers: { 'Content-Length': '100' }, body: 'tiny' }), 10));
});
test('API body parsing rejects cross-origin requests, malformed JSON and non-object payloads', async () => {
  for (const body of ['[1]', 'null', '{broken']) await assert.rejects(bodyOf(new Request('http://localhost', { method: 'POST', body })));
  await assert.rejects(bodyOf(new Request('http://localhost', { method: 'POST', headers: { Origin: 'https://foreign.test' }, body: '{}' })));
  assert.deepEqual(await bodyOf(new Request('http://localhost', { method: 'POST', body: '{"action":"save"}' })), { action: 'save' });
});
