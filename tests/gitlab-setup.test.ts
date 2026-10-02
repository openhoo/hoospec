import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePagesConfig, readPagesConfig, pagesPath } from '../scripts/pages-config.mjs';
import { GitLabOAuthAccess } from '../src/lib/gitlab-auth';
import { GitLabBackend } from '../src/lib/gitlab-backend';
import { GitLabClient, normalizeGitLabConfig } from '../src/lib/gitlab-client';
import { documentFromSource } from '../src/lib/json-document';

const run = promisify(execFile);
const config = { instance: 'https://gitlab.example.test/gitlab', project: 'group/project', branch: 'main', directory: 'hoospec', specDirectory: '', adrDirectory: 'docs/adr', clientId: 'public-app', requireMembership: true };
test('installation preserves existing CI, excludes private runtime files and refuses existing or linked targets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hoospec-install-test-'));
  const installer = path.resolve('scripts/install-gitlab.mjs');
  try {
    await writeFile(path.join(root, '.gitlab-ci.yml'), '# existing pipeline\n');
    await run(process.execPath, [installer, root]);
    assert.equal(await readFile(path.join(root, '.gitlab-ci.yml'), 'utf8'), '# existing pipeline\n');
    assert.ok((await readFile(path.join(root, 'tools/hoospec/package.json'), 'utf8')).includes('build:pages'));
    for (const privatePath of ['.env', '.env.local', 'node_modules', '.next', 'out', '.hoospec']) {
      await assert.rejects(lstat(path.join(root, 'tools/hoospec', privatePath)));
    }
    await assert.rejects(run(process.execPath, [installer, root]));
    await rm(path.join(root, 'tools'), { recursive: true });
    await mkdir(path.join(root, 'outside'));
    await symlink(path.join(root, 'outside'), path.join(root, 'tools'));
    await assert.rejects(run(process.execPath, [installer, root]));
    await assert.rejects(readFile(path.join(root, 'outside/hoospec/package.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Pages settings inherit CI, support a versioned config, and reject credentials or unknown fields', () => {
  const ci = { CI_SERVER_URL: config.instance, CI_PROJECT_PATH: config.project, CI_DEFAULT_BRANCH: 'trunk' };
  const result = resolvePagesConfig({ schemaVersion: 1, gitlab: { clientId: 'public-app', specDirectory: 'specs' } }, ci);
  assert.equal(result.project, config.project); assert.equal(result.branch, 'trunk'); assert.equal(result.specDirectory, 'specs'); assert.equal(result.requireMembership, true);
  assert.throws(() => resolvePagesConfig({ gitlab: { clientSecret: 'must-not-be-published' } }, ci));
  assert.throws(() => resolvePagesConfig({ agent: { token: 'must-not-be-published' } }, ci));
  assert.throws(() => resolvePagesConfig({ schemaVersion: 42 }, ci));
  assert.throws(() => pagesPath('../replace-root'));
  assert.equal(pagesPath('reviews/hoospec'), 'reviews/hoospec');
});
test('project URLs respect the self-hosted instance relative URL root', () => {
  assert.equal(normalizeGitLabConfig({ ...config, project: config.instance + '/group/project/-/tree/main' }).project, 'group/project');
  assert.throws(() => normalizeGitLabConfig({ ...config, project: 'https://another-instance.test/group/project' }));
});
test('OAuth refresh serializes concurrent callers and rotates the refresh token only in memory', async () => {
  let clock = 0, requests = 0;
  const used: string[] = [];
  const auth = new GitLabOAuthAccess(config.instance, config.clientId, { access_token: 'initial', refresh_token: 'refresh-0', expires_in: 60 }, async (_url, init) => {
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.redirect, 'error');
    used.push(new URLSearchParams(String(init?.body)).get('refresh_token')!); requests++;
    return Response.json({ access_token: 'access-' + requests, refresh_token: 'refresh-' + requests, expires_in: 60 });
  }, () => clock);
  assert.equal(await auth.getToken(), 'initial'); clock = 40000;
  assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]), ['access-1', 'access-1', 'access-1']);
  assert.equal(requests, 1); clock = 80000; assert.equal(await auth.getToken(), 'access-2');
  assert.deepEqual(used, ['refresh-0', 'refresh-1']); auth.disconnect(); await assert.rejects(auth.getToken());
});
test('an in-flight OAuth refresh cannot resurrect a disconnected session or expose provider errors', async () => {
  let finish!: (response: Response) => void;
  const auth = new GitLabOAuthAccess(config.instance, config.clientId, { access_token: 'initial', refresh_token: 'refresh', expires_in: 1 }, () => new Promise(resolve => { finish = resolve; }));
  const pending = auth.getToken(); auth.disconnect(); finish(Response.json({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 60 }));
  await assert.rejects(pending, /Anmeldung ist abgelaufen/); await assert.rejects(auth.getToken());
  const denied = new GitLabOAuthAccess(config.instance, config.clientId, { access_token: 'old', refresh_token: 'refresh', expires_in: 1 }, async () => new Response('private-provider-body', { status: 400 }));
  await assert.rejects(denied.getToken(), error => error instanceof Error && !error.message.includes('private-provider-body'));
});
test('nonmembers cannot enter the project studio even when the repository is publicly readable', async () => {
  const client = new GitLabClient(config, 'fixture-token', async () => Response.json({ permissions: { project_access: null, group_access: null } }));
  await assert.rejects(client.verifyMembership(), /nur für Mitglieder/);
});
test('Developers can propose MRs against a protected target but cannot write a protected draft branch', async () => {
  const client = new GitLabClient(config, 'fixture-token', async url => Response.json(String(url).includes('/branches/') ? { commit: { id: 'head' }, can_push: false } : { permissions: { group_access: { access_level: 30 } } }));
  await client.verifyMembership(); assert.equal(client.readOnly, false); await client.head(); assert.equal(client.readOnly, false); await client.head('hoospec/protected'); assert.equal(client.readOnly, true);
});
test('read-only project members can load documents but neither commit nor start AI edits', async () => {
  const document = documentFromSource('# ADR\n', 'adr.md');
  const manifest = { schemaVersion: 1, workspace: { schemaVersion: 2, revision: 1, activeFileId: 'adr', files: [{ id: 'adr', filename: 'adr.md', document, version: 1, reviewed: false }], changes: [], history: {} }, paths: { adr: 'docs/adr/adr.md' } };
  let posts = 0;
  const backend = new GitLabBackend(config, 'fixture-token', async (url, init) => {
    if (init?.method === 'POST') posts++;
    if (String(url).includes('/branches/')) return Response.json({ commit: { id: 'head' }, can_push: false });
    if (String(url).includes('/files/')) return Response.json({ content: Buffer.from(JSON.stringify(manifest)).toString('base64'), size: 1000, encoding: 'base64', last_commit_id: 'head' });
    return Response.json({ permissions: { project_access: { access_level: 20 } } });
  });
  const state = await backend.load(); assert.equal(state.files.length, 1); assert.equal(backend.readOnly, true);
  await assert.rejects(backend.request({ action: 'save', actor: 'test', fileId: 'adr', version: 1, source: '# Changed\n' }), /Leserechte/);
  await assert.rejects(backend.repository.submit('Forbidden'), /Schreibrechte/);
  assert.equal((await backend.agent({})).status, 403); assert.equal(posts, 0); backend.disconnect();
});
test('embedding preserves the existing website and refuses collisions or symlink escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hoospec-attach-'));
  try {
    await mkdir(path.join(root, '.hoospec-pages/hoospec'), { recursive: true });
    await writeFile(path.join(root, '.hoospec-pages/path'), 'hoospec\n');
    await writeFile(path.join(root, '.hoospec-pages/hoospec/.hoospec-generated'), 'generated');
    await writeFile(path.join(root, '.hoospec-pages/hoospec/index.html'), '<h1>Hoospec</h1>');
    await mkdir(path.join(root, 'public'), { recursive: true });
    await writeFile(path.join(root, 'public/index.html'), '<h1>Existing project website</h1>');
    await run('sh', [path.resolve('scripts/attach-pages.sh'), 'public'], { cwd: root });
    assert.equal(await readFile(path.join(root, 'public/index.html'), 'utf8'), '<h1>Existing project website</h1>');
    assert.equal(await readFile(path.join(root, 'public/hoospec/index.html'), 'utf8'), '<h1>Hoospec</h1>');
    await writeFile(path.join(root, 'public/hoospec/stale.html'), 'stale');
    await run('sh', [path.resolve('scripts/attach-pages.sh'), 'public'], { cwd: root });
    await assert.rejects(readFile(path.join(root, 'public/hoospec/stale.html')));
    await rm(path.join(root, 'public/hoospec/.hoospec-generated'));
    await assert.rejects(run('sh', [path.resolve('scripts/attach-pages.sh'), 'public'], { cwd: root }));
    assert.equal(await readFile(path.join(root, 'public/hoospec/index.html'), 'utf8'), '<h1>Hoospec</h1>');
    await assert.rejects(run('sh', [path.resolve('scripts/attach-pages.sh'), '../escape'], { cwd: root }));
    await symlink(path.join(root, 'public'), path.join(root, 'linked-public'));
    await assert.rejects(run('sh', [path.resolve('scripts/attach-pages.sh'), 'linked-public'], { cwd: root }));
  } finally { await rm(root, { recursive: true }); }
});

test('repository paths support independent output directories and reject ambiguous or unsafe settings', () => {
  const result = resolvePagesConfig({ paths: { specs: 'acceptance/features', adrs: 'architecture/decisions', workspace: '.hoospec-data' } });
  assert.equal(result.specDirectory, 'acceptance/features');
  assert.equal(result.adrDirectory, 'architecture/decisions');
  assert.equal(result.directory, '.hoospec-data');
  assert.equal(resolvePagesConfig({ paths: { specs: '', adrs: '' } }).specDirectory, '');
  for (const paths of [{ specs: '../outside' }, { adrs: 'docs/../outside' }, { workspace: '' }, { secret: 'no' }]) assert.throws(() => resolvePagesConfig({ paths }));
  assert.throws(() => resolvePagesConfig({ paths: { specs: 'features' }, gitlab: { specDirectory: 'specs' } }), /widersprechen/);
});
test('Pages prefers project-root config and falls back to the embedded config only when absent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hoospec-config-'));
  try {
    const embedded = path.join(root, 'tools/hoospec'); await mkdir(embedded, { recursive: true });
    await writeFile(path.join(embedded, 'hoospec.config.json'), JSON.stringify({ paths: { specs: 'fallback' } }));
    assert.equal((await readPagesConfig(embedded, { CI_PROJECT_DIR: root, NODE_ENV: 'test' })).specDirectory, 'fallback');
    await writeFile(path.join(root, 'hoospec.config.json'), JSON.stringify({ paths: { specs: 'chosen' } }));
    assert.equal((await readPagesConfig(embedded, { CI_PROJECT_DIR: root, NODE_ENV: 'test' })).specDirectory, 'chosen');
    await writeFile(path.join(root, 'hoospec.config.json'), '{invalid');
    await assert.rejects(readPagesConfig(embedded, { CI_PROJECT_DIR: root, NODE_ENV: 'test' }), /ungültig/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
