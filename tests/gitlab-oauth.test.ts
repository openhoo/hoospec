import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { completeGitLabLogin } from '../src/lib/gitlab-oauth';

function browserFixture(t: TestContext, state: string) {
  const config = { instance: 'https://gitlab.example.test', project: 'team/project', branch: 'main', directory: 'hoospec', specDirectory: '', adrDirectory: 'docs/adr', clientId: 'public-app', requireMembership: true };
  const redirect = 'https://studio.example.test/project/hoospec/';
  const storage = new Map([['hoospec-gitlab-oauth', JSON.stringify({ config, state: 'expected-state', verifier: 'v'.repeat(64), redirect, created: Date.now() })]]);
  const replaced: string[] = [];
  const values = { location: { origin: 'https://studio.example.test', pathname: '/project/hoospec/', search: '?code=fixture-code&state=' + state }, sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, removeItem: (key: string) => storage.delete(key) }, history: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) } };
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
  }
  return { storage, replaced, redirect };
}
test('OAuth rejects a forged state, clears the callback URL and never exchanges the code', async t => {
  const fixture = browserFixture(t, 'forged-state'), originalFetch = globalThis.fetch;
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Must not exchange'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(completeGitLabLogin(), /nicht sicher zugeordnet/);
  assert.equal(calls, 0); assert.equal(fixture.storage.size, 0); assert.deepEqual(fixture.replaced, [fixture.redirect]);
});
test('a valid PKCE callback yields an in-memory session and leaves no credential in session storage', async t => {
  const fixture = browserFixture(t, 'expected-state'), originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://gitlab.example.test/oauth/token'); assert.deepEqual(fixture.replaced, [fixture.redirect]);
    const body = new URLSearchParams(String(init?.body)); assert.equal(body.get('code_verifier'), 'v'.repeat(64)); assert.equal(body.has('client_secret'), false);
    return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 7200 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const login = await completeGitLabLogin(); assert.equal(await login!.access.getToken(), 'fixture-access'); assert.equal(fixture.storage.size, 0);
  login!.access.disconnect(); await assert.rejects(login!.access.getToken());
});
