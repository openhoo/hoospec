import test from 'node:test';
import assert from 'node:assert/strict';
import { loginKeys, openCredential, copilotEndpoint } from '../src/lib/copilot-envelope';
import { runLogin, sealCredential } from '../scripts/copilot-login.mjs';
import { CopilotRunnerConnection } from '../src/lib/copilot-runner';
import { GitLabClient } from '../src/lib/gitlab-client';

test('encrypted runner artifact is bound to this browser, pipeline and project', async () => {
  const keys = await loginKeys(), other = await loginKeys();
  const expected = { nonce: keys.nonce, pipeline: '42', project: '7' };
  const data = { ...expected, token: 'synthetic-copilot-token', endpoint: 'https://api.githubcopilot.com', expires: Date.now() + 60000 };
  const sealed = await sealCredential(data, keys.publicKey);
  assert.ok(!JSON.stringify(sealed).includes(data.token));
  assert.deepEqual(await openCredential(sealed, keys.privateKey, expected), data);
  await assert.rejects(openCredential(sealed, other.privateKey, expected));
  await assert.rejects(openCredential(sealed, keys.privateKey, {...expected, pipeline: '43'}));
  await assert.rejects(openCredential({...sealed, ciphertext: sealed.ciphertext.slice(0, -4) + 'AAAA'}, keys.privateKey, expected));
  const expired = await sealCredential({...data, expires: Date.now() - 1000}, keys.publicKey);
  await assert.rejects(openCredential(expired, keys.privateKey, expected), /abgelaufen/);
  for (const url of ['https://evil.example', 'https://api.githubcopilot.com.evil.example', 'https://api.githubcopilot.com/path', 'https://user@api.githubcopilot.com', 'http://api.githubcopilot.com']) assert.throws(() => copilotEndpoint(url));
});

test('runner handles pending/slow_down, encrypts only the API credential and refuses debug or foreign endpoints', async () => {
  const keys = await loginKeys(); let time = Date.now(), calls = 0, result: unknown, challenge: Record<string, unknown> | undefined;
  const env = { CI_PIPELINE_SOURCE: 'api', CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main', CI_PIPELINE_ID: '42', CI_PROJECT_ID: '7', HOOSPEC_COPILOT_LOGIN: '1', HOOSPEC_COPILOT_CLIENT_ID: 'own-public-app', HOOSPEC_COPILOT_PUBLIC_KEY: keys.publicKey, HOOSPEC_COPILOT_NONCE: keys.nonce };
  const waits: number[] = [];
  const options = { now: () => time, sleep: async (ms: number) => { waits.push(ms); time += ms; }, challenge: (data: Record<string, unknown>) => { challenge = data; }, output: async (data: unknown) => { result = data; }, fetcher: async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/device/code')) return Response.json({device_code: 'synthetic-private-device', user_code: 'TEST-CODE', interval: 5, expires_in: 900});
    if (url.endsWith('/access_token')) return Response.json(++calls === 1 ? {error: 'authorization_pending'} : calls === 2 ? {error: 'slow_down'} : {access_token: 'gho_synthetic_oauth'});
    return Response.json({token: 'synthetic-api-token', expires_at: Math.floor((time + 120000) / 1000), endpoints: {api: 'https://api.githubcopilot.com'}});
  } };
  await runLogin(env, options);
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.equal(challenge?.userCode, 'TEST-CODE');
  assert.ok(!JSON.stringify([result, challenge]).includes('gho_synthetic_oauth'));
  assert.ok(!JSON.stringify([result, challenge]).includes('synthetic-private-device'));
  const opened = await openCredential(result as Parameters<typeof openCredential>[0], keys.privateKey, {nonce: keys.nonce, pipeline: '42', project: '7'});
  assert.equal(opened.token, 'synthetic-api-token');
  await assert.rejects(runLogin({...env, CI_DEBUG_TRACE: 'true'}, options));
  await assert.rejects(runLogin({...env, CI_COMMIT_BRANCH: 'untrusted'}, options));
  await assert.rejects(runLogin(env, {...options, fetcher: async (url: string | URL | Request) => String(url).endsWith('/v2/token') ? Response.json({ token: 'synthetic', expires_at: time / 1000 + 60, endpoints: {api: 'https://evil.example'} }) : options.fetcher(url)}));
});

test('Pages runner login streams direct AI, rejects truncation and expires on disconnect', async () => {
  let variables: {key: string; value: string}[] = [];
  const calls: string[] = []; let streamMode = 'complete';
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/projects/team%2Fspec')) return Response.json({id: 7, default_branch: 'main'});
    if (url.endsWith('/pipeline')) { variables = JSON.parse(String(init?.body)).variables; return Response.json({id: 42}); }
    if (url.includes('/jobs?')) return Response.json([{id: 9, name: 'hoospec-copilot-login', status: 'success'}]);
    const value = (key: string) => variables.find(item => item.key === key)!.value;
    if (url.endsWith('/trace')) return new Response('HOOSPEC_COPILOT_LOGIN ' + JSON.stringify({nonce: value('HOOSPEC_COPILOT_NONCE'), userCode: 'TEST-CODE', verificationUrl: 'https://github.com/login/device', expiresIn: 900}));
    if (url.endsWith('/login.json')) return Response.json(await sealCredential({nonce: value('HOOSPEC_COPILOT_NONCE'), pipeline: '42', project: '7', token: 'synthetic-token', endpoint: 'https://api.githubcopilot.com', expires: Date.now()+60000}, value('HOOSPEC_COPILOT_PUBLIC_KEY')));
    if (url.endsWith('/models')) return Response.json({data: [{id: 'gpt-4.1', name: 'GPT', capabilities: {type: 'chat'}, supported_endpoints: ['/chat/completions']}]});
    if (url.endsWith('/chat/completions')) return new Response('data: ' + JSON.stringify({choices:[{delta:{content:'  Given a changed step'},...(streamMode === 'truncated' ? {} : {finish_reason: streamMode === 'length' ? 'length' : 'stop'})}]}) + '\n\n' + (streamMode === 'complete' ? 'data: [DONE]\n\n' : ''));
    return Response.json({});
  };
  const client = new GitLabClient({instance:'https://gitlab.example', project:'team/spec', branch:'main', clientId:'', directory:'hoospec', specDirectory:'', adrDirectory:'docs/adr'}, 'synthetic-gitlab', fetcher as typeof fetch);
  const connection = new CopilotRunnerConnection(client, 'own-public-app', fetcher as typeof fetch);
  assert.equal((await connection.start()).userCode, 'TEST-CODE');
  assert.equal((await connection.poll()).connected, true);
  const { parseDocument } = await import('../src/lib/document');
  const { flattenNodes } = await import('../src/lib/gherkin');
  const source = 'Feature: Test\n  Scenario: Test\n    Given a step\n', node = flattenNodes(parseDocument(source,'test.feature')).find(item=>item.kind==='step')!;
  const response = await connection.agent({source, filename:'test.feature', nodeId:node.id, instruction:'Change'});
  const text = await response.text(); assert.ok(text.includes('event: complete')); assert.ok(text.includes('Given a changed step'));
  assert.ok(calls.some(url=>url.startsWith('https://api.githubcopilot.com/chat')));
  assert.ok(!JSON.stringify(variables).includes('synthetic-token'));
  for (const mode of ['truncated', 'length']) { streamMode = mode; const result = await (await connection.agent({source, filename:'test.feature', nodeId:node.id, instruction:'Change'})).text(); assert.ok(result.includes('event: error')); assert.ok(!result.includes('event: complete')); }
  connection.disconnect(); assert.equal(connection.connected, false); assert.equal((await connection.agent({})).status, 401);
});
