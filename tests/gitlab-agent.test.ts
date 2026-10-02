import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabBackend } from '../src/lib/gitlab-backend';
import { documentFromSource } from '../src/lib/json-document';
import { flattenNodes } from '../src/lib/gherkin';
import { parseDocument } from '../src/lib/document';

function fixture(bridge: typeof fetch, verify = true) {
  const source = 'Feature: Checkout\n  Scenario: Pay\n    Given a card\n';
  const document = documentFromSource(source, 'checkout.feature');
  const manifest = { schemaVersion: 1, workspace: { schemaVersion: 2, revision: 1, activeFileId: 'checkout', files: [{ id: 'checkout', filename: 'checkout.feature', document, version: 1, reviewed: false }], changes: [], history: {} }, paths: { checkout: 'features/checkout.feature' } };
  let commits = 0;
  const backend = new GitLabBackend({ instance: 'https://gitlab.test', project: 'group/project', branch: 'main', directory: 'hoospec', specDirectory: '', adrDirectory: 'docs/adr', clientId: '', agentUrl: 'https://agent.test/api/repository-agent', requireMembership: true }, 'fixture-token', async (url, init) => {
    if (init?.method === 'POST') commits++;
    if (String(url).includes('/branches/')) return Response.json({ commit: { id: 'head' }, can_push: true });
    if (String(url).includes('/files/')) return Response.json({ content: Buffer.from(JSON.stringify(manifest)).toString('base64'), size: 1000, encoding: 'base64', last_commit_id: 'head' });
    return Response.json({ permissions: { project_access: { access_level: 40 } } });
  }, 'fixture-bridge-token', async (url, init) => { if (verify && JSON.parse(String(init?.body)).action === 'connection') return Response.json({aiReady:true, aiModels:[{id:'test-model',name:'Test model'},{id:'second-model',name:'Second model'}],aiModel:'test-model'}); return bridge(url,init); });
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

test('Copilot connection uses the existing selection and saves only a validated local draft', async () => {
  const { CopilotConnection } = await import('../src/lib/copilot-connection');
  const { backend, body, commits } = fixture(async () => { throw new Error('Legacy bridge must not be used'); });
  await backend.load();
  const connection = new CopilotConnection('https://copilot.test/api/copilot', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.action === 'start') return Response.json({ session: 'a'.repeat(64), userCode: 'CODE', verificationUrl: 'https://github.com/login/device' });
    if (request.action === 'poll') return Response.json({ status: 'connected', session: 'b'.repeat(64), models: [{ id: 'test-model', name: 'Test model' }] });
    if (request.action === 'disconnect') return Response.json({ disconnected: true });
    assert.equal(request.nodeId, body.nodeId); assert.equal(request.model, 'test-model');
    return new Response('event: complete\ndata: {"replacement":"    Given a Copilot card"}\n\n');
  });
  await connection.start(); await connection.poll(); backend.configureCopilot(connection);
  assert.equal((await backend.load()).aiReady, true); assert.match((await backend.load()).model, /Copilot/);
  // Changing the model / reopening the connection must not terminate its session.
  backend.configureCopilot(connection); assert.equal(connection.connected, true);
  const result = await (await backend.agent(body)).text(); assert.match(result, /event: complete/);
  assert.match((await backend.load()).files[0].source, /Copilot card/); assert.equal(commits(), 0);
  backend.disconnect(); assert.equal(connection.connected, false);
});
test('invalid Copilot output cannot overwrite a saved Gherkin document', async () => {
  const { CopilotConnection } = await import('../src/lib/copilot-connection');
  const { backend, body, commits } = fixture(async () => { throw new Error('Legacy bridge must not be used'); }); await backend.load();
  const connection = new CopilotConnection('https://copilot.test/api/copilot', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.action === 'start') return Response.json({ session: 'a'.repeat(64), userCode: 'CODE', verificationUrl: 'https://github.com/login/device' });
    if (request.action === 'poll') return Response.json({ status: 'connected', session: 'b'.repeat(64), models: [{ id: 'test', name: 'Test' }] });
    if (request.action === 'disconnect') return Response.json({});
    return new Response('event: complete\ndata: {"replacement":"NOT VALID GHERKIN"}\n\n');
  });
  await connection.start(); await connection.poll(); backend.configureCopilot(connection);
  const response = await backend.agent(body); assert.match(await response.text(), /event: error/);
  assert.match((await backend.load()).files[0].source, /Given a card/); assert.equal(commits(), 0); backend.disconnect();
});

test('configured bridge credentials alone never enable AI and unknown models are rejected', async () => {
  const {backend,body}=fixture(async()=>Response.json({error:'denied'}, {status:401}),false);
  assert.equal((await backend.load()).aiReady,false);
  assert.equal((await backend.agent(body)).status,503);backend.disconnect();
  let chosen='';
  const connected=fixture(async(_url,init)=>{chosen=JSON.parse(String(init?.body)).model;return new Response('event: complete\ndata: {"replacement":"    Given a better card"}\n\n');});
  assert.deepEqual((await connected.backend.load()).aiModels?.map(item=>item.id),['test-model','second-model']);
  assert.equal((await connected.backend.agent({...connected.body,model:'unavailable'})).status,400);
  await (await connected.backend.agent({...connected.body,model:'second-model'})).text();assert.equal(chosen,'second-model');connected.backend.disconnect();
});
