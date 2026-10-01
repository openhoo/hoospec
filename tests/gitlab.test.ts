import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitLabConfig, decodeRepositoryFile, GitLabClient, type GitLabConfig } from '../src/lib/gitlab-client';
import { GitLabBackend, parseRepositoryManifest, repositoryFilename } from '../src/lib/gitlab-backend';
import { documentFromSource } from '../src/lib/json-document';

const config: GitLabConfig = { instance: 'https://gitlab.example.test', project: 'team/project', branch: 'feature/review', directory: 'hoospec', specDirectory: '', adrDirectory: 'docs/adr', clientId: '' };
test('a history-heavy workspace cannot be committed past the readable manifest limit', async () => {
  const source = '# ADR\n\n' + '漢'.repeat(100000) + '\n';
  const document = documentFromSource(source, 'size.md');
  const manifest = { schemaVersion: 1, workspace: { schemaVersion: 2, revision: 1, activeFileId: 'size', files: [{ id: 'size', filename: 'size.md', document, version: 1, reviewed: false }], changes: [{ id: 'initial', fileId: 'size', filename: 'size.md', actor: 'test', instruction: 'Initial edit', time: '2026-10-01T00:00:00Z', kind: 'manual', version: 1, before: document, after: document }], history: { size: { undo: Array(49).fill(document), redo: [] } } }, paths: { size: 'docs/adr/size.md' } };
  const content = JSON.stringify(manifest); assert.ok(Buffer.byteLength(content) < 16000000);
  let commits = 0;
  const backend = new GitLabBackend(config, 'fixture-token', async (url, init) => {
    if (init?.method === 'POST') commits++;
    if (String(url).includes('/branches/')) return Response.json({ commit: { id: 'head' }, can_push: true });
    return Response.json({ content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content), encoding: 'base64', last_commit_id: 'head' });
  });
  await backend.load();
  await assert.rejects(backend.request({ action: 'save', fileId: 'size', version: 1, source: source + 'Changed\n', actor: 'test' }), /zu groß/);
  assert.equal(commits, 0); backend.disconnect();
});
test('GitLab config restricts credential destinations and normalizes repository paths', () => {
  assert.equal(normalizeGitLabConfig({ ...config, instance: 'http://127.0.0.1:8929', directory: '/docs/hoospec/' }).directory, 'docs/hoospec');
  for (const instance of ['http://untrusted.test', 'https://token@gitlab.test', 'https://gitlab.test?token=x']) assert.throws(() => normalizeGitLabConfig({ ...config, instance }));
  for (const directory of ['../escape', 'docs/../escape', 'docs\\escape']) assert.throws(() => normalizeGitLabConfig({ ...config, directory }));
  assert.throws(() => normalizeGitLabConfig({ ...config, agentUrl: 'http://untrusted.test/agent' }));
});
test('GitLab files decode UTF-8 including German text and line endings', () => {
  const source = '# Öffentliche Entscheidung 🦉\r\n';
  assert.equal(decodeRepositoryFile({ file_path: 'adr.md', encoding: 'base64', content: Buffer.from(source).toString('base64'), last_commit_id: 'commit', size: Buffer.byteLength(source) }), source);
});
test('repository manifests validate histories, path ownership and format before loading', () => {
  const document = documentFromSource('# ADR\n', 'adr.md');
  const workspace = { schemaVersion: 2, revision: 1, activeFileId: 'adr', files: [{ id: 'adr', filename: 'adr.md', document, version: 1, reviewed: false }], changes: [], history: {} };
  const input = { schemaVersion: 1, workspace, paths: { adr: 'docs/adr/adr.md' } };
  assert.equal(parseRepositoryManifest(JSON.stringify(input)).paths.adr, 'docs/adr/adr.md');
  assert.throws(() => parseRepositoryManifest(JSON.stringify({ ...input, paths: { adr: '../adr.md' } })));
  assert.throws(() => parseRepositoryManifest(JSON.stringify({ ...input, paths: { adr: 'features/adr.feature' } })));
});
test('GitLab credentials stay in headers; project, file and branch paths are encoded', async () => {
  let observed = '';
  const fetcher: typeof fetch = async (input, init) => {
    observed = String(input);
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-private-token');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    return Response.json({ file_path: 'docs/a.feature', content: '', encoding: 'base64', size: 0, last_commit_id: 'commit' });
  };
  const client = new GitLabClient(config, 'test-private-token', fetcher);
  await client.file('docs/a.feature', 'feature/review');
  assert.ok(observed.includes('/projects/team%2Fproject/repository/files/docs%2Fa.feature?ref=feature%2Freview'));
  assert.ok(!observed.includes('test-private-token'));
  client.disconnect(); await assert.rejects(client.file('docs/a.feature', 'main'));
});
test('GitLab errors never echo provider bodies or credentials', async () => {
  const client = new GitLabClient(config, 'test-private-token', async () => new Response('sensitive-body', { status: 403 }));
  await assert.rejects(client.head(), error => error instanceof Error && !error.message.includes('sensitive-body') && error.message.includes('Zugriff'));
});
test('GitLab transport invokes browser fetch with the global receiver', async () => {
  const browserFetch: typeof fetch = async function(this: unknown) {
    assert.equal(this, globalThis, 'browser fetch must retain its Window receiver');
    return Response.json({ commit: { id: 'head' } });
  };
  assert.equal(await new GitLabClient(config, 'test-private-token', browserFetch).head(), 'head');
});

test('repository imports give duplicate, unsupported and long basenames valid distinct stable names', () => {
  const used = new Set(['checkout.feature', 'features__checkout.feature']);
  const filename = repositoryFilename('features/checkout.feature', 'gitlab-0123456789abcdef0123456789abcdef', used);
  assert.ok(!used.has(filename)); assert.equal(filename, repositoryFilename('features/checkout.feature', 'gitlab-0123456789abcdef0123456789abcdef', used));
  for (const input of ['weird/spec[1].feature', 'features/' + 'a'.repeat(200) + '.feature']) {
    const name = repositoryFilename(input, 'gitlab-0123456789abcdef0123456789abcdef', used);
    assert.ok(/^[\p{L}\p{N}_. -]+\.feature$/iu.test(name)); assert.ok(name.length <= 120); used.add(name);
  }
});
