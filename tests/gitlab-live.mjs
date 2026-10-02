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
let reviewId, reviewBranch;
const targetHead = await client.head();
await check('edits remain local until an explicit draft MR submission; target branch stays untouched', async () => {
  const source = original.replace('einfach anfühlt', 'ruhig anfühlt');
  state = await backend.request({ action: 'save-document', fileId: file.id, version: file.version, document: documentFromSource(source, file.filename), actor: 'GitLab test' });
  assert.equal(state.files.find(f => f.id === file.id).source, source);
  assert.equal(await client.head(), targetHead);
  state = await backend.repository.submit('Test shared studio');
  reviewId = state.repository.mergeRequest.iid; reviewBranch = state.repository.branch;
  assert.equal(await client.head(), targetHead);
  assert.ok((await client.mergeRequest(reviewId)).title.startsWith('Draft:'));
  const head = await client.head(reviewBranch), diff = await api(`/projects/${project.id}/repository/commits/${head}/diff`);
  assert.ok(diff.some(item => item.new_path === 'hoospec/workspace.json'));
  assert.ok(diff.some(item => item.new_path === 'features/checkout.feature'));
  assert.equal(decodeRepositoryFile(await client.file('features/checkout.feature', head)), source);
});
await check('another member can join the shared draft; undo/redo stays local until synchronizing', async () => {
  const second = new GitLabBackend(config, token);
  await second.load(); let state = await second.repository.join(reviewId); const current = state.files.find(f => f.id === file.id);
  assert.equal(current.version, 2); assert.equal(state.history[file.id].undo, 1);
  const head = await client.head(reviewBranch);
  state = await second.request({ action: 'undo', fileId: file.id, version: current.version, actor: 'GitLab test' });
  assert.equal(state.files.find(f => f.id === file.id).source, original); assert.equal(await client.head(reviewBranch), head);
  state = await second.request({ action: 'redo', fileId: file.id, version: state.files.find(f => f.id === file.id).version, actor: 'GitLab test' });
  assert.ok(state.files.find(f => f.id === file.id).source.includes('ruhig anfühlt'));
  assert.equal(state.repository.changes.length, 0); second.disconnect();
});
await check('simultaneous shared edits preserve the losing draft and reject synchronization', async () => {
  const one = new GitLabBackend(config, token), two = new GitLabBackend(config, token);
  await one.load(); await two.load(); const state = await one.repository.join(reviewId); await two.repository.join(reviewId);
  const current = state.files.find(f => f.id === file.id);
  const body = { action: 'save-document', fileId: file.id, version: current.version, actor: 'GitLab test' };
  await one.request({ ...body, document: documentFromSource(current.source.replace('ruhig anfühlt', 'klar anfühlt'), current.filename) });
  await two.request({ ...body, document: documentFromSource(current.source.replace('ruhig anfühlt', 'mein Entwurf anfühlt'), current.filename) });
  await one.repository.submit('Shared checkpoint');
  const conflict = await two.load(); assert.equal(conflict.repository.conflict, true); assert.ok(conflict.files.find(f => f.id === file.id).source.includes('mein Entwurf'));
  await assert.rejects(two.repository.submit('Overwrite'), /gemeinsame Stand/);
  assert.ok((await two.repository.discard()).files.find(f => f.id === file.id).source.includes('klar anfühlt'));
  assert.equal((await client.mergeRequests(reviewBranch)).length, 1); one.disconnect(); two.disconnect();
});
await check('ADR decisions and metadata synchronize atomically into the same MR', async () => {
  let state = await backend.load(); const adr = state.files.find(f => f.filename === '0001-test.md');
  state = await backend.request({ action: 'adr-decision', fileId: adr.id, version: adr.version, decision: 'We choose explicit versions.', actor: 'GitLab test' });
  const updated = state.files.find(f => f.id === adr.id); assert.ok(updated.source.includes('Status: Angenommen'));
  state = await backend.request({ action: 'review', fileId: adr.id, version: updated.version, actor: 'GitLab test' }); assert.equal(state.files.find(f => f.id === adr.id).reviewed, true);
  state = await backend.repository.submit('Record decision');
  assert.equal(state.repository.mergeRequest.iid, reviewId);
  assert.equal(decodeRepositoryFile(await client.file('docs/adr/0001-test.md', await client.head(reviewBranch))), updated.source);
  assert.equal(await client.head(), targetHead);
});
await check('external generated-file edits are detected before synchronization, retaining the local draft', async () => {
  const state = await backend.load(), current = state.files.find(f => f.id === file.id), remote = await client.file('features/checkout.feature', await client.head(reviewBranch));
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current.source + '\n# External change\n', last_commit_id: remote.last_commit_id }], 'External edit', reviewBranch);
  await backend.request({ action: 'save-document', fileId: file.id, version: current.version, actor: 'GitLab test', document: documentFromSource(current.source.replace('klar anfühlt', 'überschrieben anfühlt'), current.filename) });
  await assert.rejects(backend.repository.submit('Overwrite external file'), /außerhalb/);
  assert.ok((await backend.load()).files.find(f => f.id === file.id).source.includes('überschrieben'));
  const latest = await client.file(remote.file_path, await client.head(reviewBranch));
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current.source, last_commit_id: latest.last_commit_id }], 'Restore fixture', reviewBranch);
  await backend.repository.discard();
});
await check('atomic GitLab batch rejects outdated last_commit_id without changing another action', async () => {
  const head = await client.head(reviewBranch), remote = await client.file('features/checkout.feature', head), current = decodeRepositoryFile(remote);
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current + '\n# Race winner\n', last_commit_id: remote.last_commit_id }], 'Race winner', reviewBranch);
  await assert.rejects(client.commit([{ action: 'update', file_path: remote.file_path, content: current + '\n# Race loser\n', last_commit_id: remote.last_commit_id }, { action: 'create', file_path: 'should-not-exist.txt', content: 'Must stay absent' }], 'Race loser', reviewBranch));
  assert.equal(await client.file('should-not-exist.txt', await client.head(reviewBranch)), null);
  const latest = await client.file(remote.file_path, await client.head(reviewBranch));
  await client.commit([{ action: 'update', file_path: remote.file_path, content: current, last_commit_id: latest.last_commit_id }], 'Restore fixture', reviewBranch);
});
await check('GitLab merges the MR explicitly; a clean studio then follows the target', async () => {
  await backend.load();
  await api(`/projects/${project.id}/merge_requests/${reviewId}`, 'PUT', { title: 'Test shared studio' });
  await api(`/projects/${project.id}/merge_requests/${reviewId}?with_merge_status_recheck=true`);
  let mergeStatus;
  for (let attempt = 0; attempt < 30; attempt++) {
    const review = await api(`/projects/${project.id}/merge_requests/${reviewId}`);
    mergeStatus = review.detailed_merge_status;
    if (mergeStatus === 'mergeable') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(mergeStatus, 'mergeable', 'GitLab must finish its asynchronous mergeability check before the fixture merges');
  const merged = await api(`/projects/${project.id}/merge_requests/${reviewId}/merge`, 'PUT', { should_remove_source_branch: true });
  assert.equal(merged.state, 'merged');
  const state = await backend.load(); assert.equal(state.repository.mergeRequest, undefined); assert.equal(state.repository.branch, 'main');
  assert.ok(state.files.find(f => f.id === file.id).source.includes('klar anfühlt'));
  assert.ok(await client.file('hoospec/workspace.json', await client.head()));
});
backend.disconnect();
// Keep API metadata in a private, unpredictable directory; never follow a pre-existing temp-file symlink.
const metadataDirectory = await mkdtemp(path.join(tmpdir(), 'hoospec-gitlab-test-'));
const metadataPath = path.join(metadataDirectory, 'project.json');
await writeFile(metadataPath, JSON.stringify({ ...config, projectId: project.id, projectPath: project.path_with_namespace, webUrl: project.web_url, passed }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(`Fixture metadata: ${metadataPath}`);
console.log(`${passed} live GitLab checks passed. Project: ${project.path_with_namespace}`);
