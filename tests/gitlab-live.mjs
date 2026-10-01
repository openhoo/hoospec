import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GitLabBackend } from '../src/lib/gitlab-backend.ts';
import { GitLabClient, decodeRepositoryFile } from '../src/lib/gitlab-client.ts';
import { documentFromSource } from '../src/lib/json-document.ts';
import { seed } from '../src/lib/seed.ts';

const instance = process.env.HOOSPEC_TEST_GITLAB_URL || 'http://127.0.0.1:8929';
if (!['localhost', '127.0.0.1'].includes(new URL(instance).hostname)) throw new Error('This live fixture is restricted to a local disposable GitLab instance.');
const tokenFile = process.env.HOOSPEC_TEST_GITLAB_TOKEN_FILE;
if (!tokenFile) throw new Error('Set HOOSPEC_TEST_GITLAB_TOKEN_FILE to a protected token file for your disposable local instance.');
const token = (await readFile(tokenFile, 'utf8')).trim();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function api(path, method = 'GET', body) {
  const response = await fetch(`${instance}/api/v4${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(`GitLab fixture API failed: ${method} ${path} (${response.status})`);
  return response.json();
}
const project = await api('/projects', 'POST', { name: `hoospec-test-${Date.now()}`, visibility: 'private', initialize_with_readme: true, default_branch: 'main', pages_unique_domain_enabled: false });
const config = { instance, project: String(project.id), branch: 'main', directory: 'hoospec', specDirectory: '', adrDirectory: 'docs/adr', clientId: '' };
const client = new GitLabClient(config, token);
const original = seed.files[0].source;
await client.commit([{ action: 'create', file_path: 'features/checkout.feature', content: original }, { action: 'create', file_path: 'docs/adr/0001-test.md', content: '# Test ADR\n\nStatus: Offen\n\n## Questions\n\n- What should we choose?\n' }], 'Hoospec fixture');
let passed = 0;
async function check(name, fn) { await fn(); console.log(`✓ ${name}`); passed++; }
const backend = new GitLabBackend(config, token);
let state = await backend.load();
const file = state.files.find(file => file.filename === 'checkout.feature');
await check('real GitLab scans specs and ADRs without importing ordinary Markdown', async () => {
  assert.equal(state.files.length, 2); assert.equal(file.source, original);
});
await check('JSON and generated source are committed atomically to the selected branch', async () => {
  const source = original.replace('einfach anfühlt', 'ruhig anfühlt');
  state = await backend.request({ action: 'save-document', fileId: file.id, version: file.version, document: documentFromSource(source, file.filename), actor: 'GitLab test' });
  assert.equal(state.files.find(f => f.id === file.id).source, source);
  const head = await client.head(), commit = await api(`/projects/${project.id}/repository/commits/${head}/diff`);
  assert.ok(commit.some(item => item.new_path === 'hoospec/workspace.json'));
  assert.ok(commit.some(item => item.new_path === 'features/checkout.feature'));
  assert.equal(decodeRepositoryFile(await client.file('features/checkout.feature', head)), source);
});
await check('reconnect preserves canonical JSON, versions and recoverable undo/redo', async () => {
  const second = new GitLabBackend(config, token);
  let state = await second.load(); const current = state.files.find(f => f.id === file.id);
  assert.equal(current.version, 2); assert.equal(state.history[file.id].undo, 1);
  state = await second.request({ action: 'undo', fileId: file.id, version: current.version, actor: 'GitLab test' });
  assert.equal(state.files.find(f => f.id === file.id).source, original);
  state = await second.request({ action: 'redo', fileId: file.id, version: state.files.find(f => f.id === file.id).version, actor: 'GitLab test' });
  assert.ok(state.files.find(f => f.id === file.id).source.includes('ruhig anfühlt')); second.disconnect();
});
await check('a stale editor cannot overwrite another GitLab commit', async () => {
  const one = new GitLabBackend(config, token), two = new GitLabBackend(config, token);
  const state = await one.load(); await two.load(); const current = state.files.find(f => f.id === file.id);
  const body = { action: 'save-document', fileId: file.id, version: current.version, actor: 'GitLab test', document: documentFromSource(current.source.replace('ruhig anfühlt', 'klar anfühlt'), current.filename) };
  await one.request(body);
  await assert.rejects(two.request({ ...body, document: documentFromSource(current.source.replace('ruhig anfühlt', 'veraltet anfühlt'), current.filename) }));
  assert.ok((await two.load()).files.find(f => f.id === file.id).source.includes('klar anfühlt')); one.disconnect(); two.disconnect();
});
await check('review and ADR decisions persist in the repository with generated Markdown', async () => {
  let state = await backend.load(); const adr = state.files.find(f => f.filename === '0001-test.md');
  state = await backend.request({ action: 'adr-decision', fileId: adr.id, version: adr.version, decision: 'We choose explicit versions.', actor: 'GitLab test' });
  const updated = state.files.find(f => f.id === adr.id); assert.ok(updated.source.includes('Status: Angenommen'));
  state = await backend.request({ action: 'review', fileId: adr.id, version: updated.version, actor: 'GitLab test' }); assert.equal(state.files.find(f => f.id === adr.id).reviewed, true);
  assert.equal(decodeRepositoryFile(await client.file('docs/adr/0001-test.md', await client.head())), updated.source);
});
await check('manual edits to generated files are never overwritten silently', async () => {
  const state = await backend.load(), current = state.files.find(f => f.id === file.id), remote = await client.file('features/checkout.feature', await client.head());
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current.source + '\n# External change\n', last_commit_id: remote.last_commit_id }], 'External edit');
  await assert.rejects(backend.request({ action: 'save-document', fileId: file.id, version: current.version, actor: 'GitLab test', document: documentFromSource(current.source.replace('klar anfühlt', 'überschrieben anfühlt'), current.filename) }), /außerhalb/);
  // Restore the disposable fixture for subsequent browser tests.
  const latest = await client.file(remote.file_path, await client.head());
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current.source, last_commit_id: latest.last_commit_id }], 'Restore fixture');
});
await check('atomic GitLab batch rejects outdated last_commit_id without changing another action', async () => {
  const head = await client.head(), remote = await client.file('features/checkout.feature', head), current = decodeRepositoryFile(remote);
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current + '\n# Race winner\n', last_commit_id: remote.last_commit_id }], 'Race winner');
  await assert.rejects(client.commit([{ action: 'update', file_path: remote.file_path, content: current + '\n# Race loser\n', last_commit_id: remote.last_commit_id }, { action: 'create', file_path: 'should-not-exist.txt', content: 'Must stay absent' }], 'Race loser'));
  assert.equal(await client.file('should-not-exist.txt', await client.head()), null);
  const latest = await client.file(remote.file_path, await client.head());
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current, last_commit_id: latest.last_commit_id }], 'Restore fixture');
});
backend.disconnect();
// Keep API metadata in a private, unpredictable directory; never follow a pre-existing temp-file symlink.
const metadataDirectory = await mkdtemp(path.join(tmpdir(), 'hoospec-gitlab-test-'));
const metadataPath = path.join(metadataDirectory, 'project.json');
await writeFile(metadataPath, JSON.stringify({ ...config, projectId: project.id, projectPath: project.path_with_namespace, webUrl: project.web_url, passed }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`Fixture metadata: ${metadataPath}`);
console.log(`${passed} live GitLab checks passed. Project: ${project.path_with_namespace}`);
