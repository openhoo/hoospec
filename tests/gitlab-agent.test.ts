import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabBackend } from '../src/lib/gitlab-backend';
import { documentFromSource } from '../src/lib/json-document';
import { flattenNodes } from '../src/lib/gherkin';
import { parseDocument } from '../src/lib/document';

function fixture(bridge: typeof fetch) {
  const source = 'Feature: Checkout\n  Scenario: Pay\n    Given a card\n';
  const document = documentFromSource(source, 'checkout.feature');
  const manifest = { schemaVersion: 1, workspace: { schemaVersion: 2, revision: 1, activeFileId: 'checkout', files: [{ id: 'checkout', filename: 'checkout.feature', document, version: 1, reviewed: false }], changes: [], history: {} }, paths: { checkout: 'features/checkout.feature' } };
  let commits = 0;
  const backend = new GitLabBackend({ instance: 'https://gitlab.test', project: 'group/project', branch: 'main', directory: 'hoospec', specDirectory: '', adrDirectory: 'docs/adr', clientId: '', agentUrl: 'https://agent.test/api/repository-agent', requireMembership: true }, 'fixture-token', async (url, init) => {
    if (init?.method === 'POST') commits++;
    if (String(url).includes('/branches/')) return Response.json({ commit: { id: 'head' }, can_push: true });
    if (String(url).includes('/files/')) return Response.json({ content: Buffer.from(JSON.stringify(manifest)).toString('base64'), size: 1000, encoding: 'base64', last_commit_id: 'head' });
    return Response.json({ permissions: { project_access: { access_level: 40 } } });
  }, 'fixture-bridge-token', bridge);
  const body = { fileId: 'checkout', version: 1, nodeId: flattenNodes(parseDocument(source, 'checkout.feature')).find(node => node.kind === 'step')!.id, instruction: 'Improve', actor: 'test' };
  return { backend, body, commits: () => commits };
}
test('cancelling or disconnecting a GitLab agent aborts the bridge and never commits partial output', async () => {
  for (const mode of ['reader', 'disconnect', 'signal']) {
    let signal: AbortSignal | undefined, cancelled = false;
    const { backend, body, commits } = fixture(async (_url, init) => {
      signal = init!.signal as AbortSignal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"Given a better card"}\n\n')); }, cancel() { cancelled = true; } }));
    });
    const abort = new AbortController();
    const response = await backend.agent(body, abort.signal), reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    if (mode === 'reader') await reader.cancel();
    else { if (mode === 'disconnect') backend.disconnect(); else abort.abort(); await reader.read(); }
    assert.equal(signal!.aborted, true); assert.equal(cancelled, true); assert.equal(commits(), 0); backend.disconnect();
  }
});
test('incomplete or invalid GitLab bridge output produces an error without repository writes', async () => {
  for (const output of ['event: delta\ndata: {"text":"Given partial"}\n\n', 'event: complete\ndata: {"replacement":"NOT VALID GHERKIN"}\n\n']) {
    const { backend, body, commits } = fixture(async () => new Response(output));
    const response = await backend.agent(body);
    assert.match(await response.text(), /event: error/);
    assert.equal(commits(), 0); backend.disconnect();
  }
});
test('a completed GitLab agent edit is validated into a local draft without a commit', async () => {
  const { backend, body, commits } = fixture(async () => new Response('event: complete\ndata: {"replacement":"    Given a better card"}\n\n'));
  const response = await backend.agent(body), result = await response.text();
  assert.match(result, /event: complete/); assert.doesNotMatch(result, /event: error/);
  assert.match((await backend.load()).files[0].source, /a better card/);
  assert.equal((await backend.load()).repository!.changes.length, 1); assert.equal(commits(), 0); backend.disconnect();
});
