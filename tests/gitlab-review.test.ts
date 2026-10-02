import test from 'node:test';
import assert from 'node:assert/strict';
import { GitLabBackend } from '../src/lib/gitlab-backend';
import { MemoryDraftStore, type RepositoryDraftStore } from '../src/lib/repository-draft';
import { documentFromSource } from '../src/lib/json-document';

function fixture(paths: { specDirectory?: string; adrDirectory?: string } = {}) {
  const source = 'Feature: Checkout\n  Scenario: Pay\n    Given a card\n';
  const manifest = { schemaVersion: 1, workspace: { schemaVersion: 2, revision: 1, activeFileId: 'checkout', files: [{ id: 'checkout', filename: 'checkout.feature', document: documentFromSource(source, 'checkout.feature'), version: 1, reviewed: false }], changes: [], history: {} }, paths: { checkout: 'features/checkout.feature' } };
  const branches = new Map([['main', 'initial']]);
  const contents = new Map([['initial', new Map([['hoospec/workspace.json', JSON.stringify(manifest)], ['features/checkout.feature', source]])]]);
  const requests: Record<string, unknown>[] = [];
  const mrs: { iid: number; source_branch: string; target_branch: string; title: string; state: string; web_url: string }[] = [];
  let failMr = false, lostCommitResponse = false, rejectCommit = false, role = 30;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string); requests.push(body);
      if (url.pathname.endsWith('/commits')) {
        if (rejectCommit) return new Response('', { status: 400 });
        const parent = branches.get(body.branch) || body.start_sha;
        const files = new Map(contents.get(parent));
        for (const action of body.actions) files.set(action.file_path, action.content);
        const sha = `commit-${requests.length}`; contents.set(sha, files); branches.set(body.branch, sha);
        if (lostCommitResponse) { lostCommitResponse = false; throw new Error('Lost response'); }
        return Response.json({ id: sha });
      }
      if (failMr) return new Response('', { status: 503 });
      const mr = { iid: mrs.length + 1, source_branch: body.source_branch, target_branch: body.target_branch, title: body.title, state: 'opened', web_url: 'https://gitlab.test/group/project/-/merge_requests/1' }; mrs.push(mr); return Response.json(mr);
    }
    if (url.pathname.includes('/branches/')) {
      const branch = decodeURIComponent(url.pathname.split('/branches/')[1]);
      return branches.has(branch) ? Response.json({ commit: { id: branches.get(branch) }, can_push: branch !== 'main' }) : new Response('', { status: 404 });
    }
    if (url.pathname.includes('/files/')) {
      const path = decodeURIComponent(url.pathname.split('/files/')[1]), ref = url.searchParams.get('ref')!;
      const sha = branches.get(ref) || ref, content = contents.get(sha)?.get(path);
      return content === undefined ? new Response('', { status: 404 }) : Response.json({ content: Buffer.from(content).toString('base64'), size: Buffer.byteLength(content), encoding: 'base64', last_commit_id: sha });
    }
    if (/\/merge_requests\/\d+$/.test(url.pathname)) return Response.json(mrs.find(mr => mr.iid === Number(url.pathname.split('/').at(-1))));
    if (url.pathname.endsWith('/merge_requests')) return Response.json(mrs.filter(mr => mr.state === 'opened' && (!url.searchParams.get('source_branch') || mr.source_branch === url.searchParams.get('source_branch'))));
    return Response.json({ permissions: { project_access: { access_level: role } } });
  };
  const create = (draftStore?: RepositoryDraftStore) => new GitLabBackend({ instance: 'https://gitlab.test', project: 'group/project', branch: 'main', directory: 'hoospec', specDirectory: '', adrDirectory: '', clientId: '', requireMembership: true, ...paths }, 'test-token', fetcher, '', fetch, draftStore);
  const save = (backend: GitLabBackend, version: number, label: string) => backend.request({ action: 'save', fileId: 'checkout', version, source: source.replace('a card', label), actor: 'Test' });
  return { create, save, requests, branches, mrs, source, failMr: (value: boolean) => { failMr = value; }, loseCommit: () => { lostCommitResponse = true; }, rejectCommit: (value: boolean) => { rejectCommit = value; }, role: (value: number) => { role = value; } };
}

test('manual/agent drafts and polling never commit; one explicit submission creates a draft MR off protected main', async () => {
  const f = fixture(), backend = f.create(); await backend.load();
  await f.save(backend, 1, 'a better card');
  const state = await backend.applyAgentChange('checkout', 2, f.source.replace('a card', 'an agent card'), 'Test', 'Agent edit');
  assert.equal(state.files[0].version, 3); assert.equal(state.repository!.changes.length, 1);
  assert.equal((await backend.load()).files[0].source, state.files[0].source); assert.equal(f.requests.length, 0);
  const saved = await backend.repository.submit('Improve payment');
  const commits = f.requests.filter(body => body.actions);
  assert.equal(commits.length, 1); assert.equal(commits[0].start_sha, 'initial'); assert.notEqual(commits[0].branch, 'main');
  assert.ok(!(commits[0].commit_message as string).includes('[skip ci]'));
  assert.equal((commits[0].actions as unknown[]).length, 2);
  assert.equal(f.branches.get('main'), 'initial'); assert.equal(f.mrs[0].title, 'Draft: Improve payment');
  assert.equal(saved.repository!.changes.length, 0); assert.equal(saved.repository!.mergeRequest!.iid, 1); backend.disconnect();
});
test('undo to baseline and navigation are no-ops for submission', async () => {
  const f = fixture(), backend = f.create(); await backend.load(); await f.save(backend, 1, 'a better card');
  await backend.request({ action: 'undo', fileId: 'checkout', version: 2, actor: 'Test' });
  await backend.request({ action: 'navigate', fileId: 'checkout' });
  assert.equal((await backend.load()).repository!.changes.length, 0);
  await assert.rejects(backend.repository.submit('No-op'), /Keine Änderungen/); assert.equal(f.requests.length, 0); backend.disconnect();
});
test('joining the same MR shares checkpoints; conflicting pending edits survive polling and cannot overwrite each other', async () => {
  const f = fixture(), one = f.create(), two = f.create(); await one.load(); await f.save(one, 1, 'a better card'); await one.repository.submit('Session');
  await two.load(); await two.repository.join(1);
  assert.equal((await two.load()).files[0].version, 2); assert.equal((await two.repository.sessions()).length, 1);
  await f.save(one, 2, 'a team card'); await f.save(two, 2, 'my own card');
  await one.repository.submit('Team change');
  const polled = await two.load(); assert.equal(polled.repository!.conflict, true); assert.match(polled.files[0].source, /my own card/);
  await assert.rejects(two.repository.submit('Overwrite'), /gemeinsame Stand/);
  assert.equal(f.requests.filter(body => body.actions).length, 2); assert.equal(f.mrs.length, 1);
  const discarded = await two.repository.discard(); assert.match(discarded.files[0].source, /a team card/); assert.equal(discarded.repository!.conflict, false);
  await two.repository.leave(); assert.equal((await two.load()).files[0].source, f.source); one.disconnect(); two.disconnect();
});
test('MR failure and lost commit response are retryable without duplicate commits or lost drafts', async () => {
  for (const failure of ['mr', 'commit-response']) {
    const f = fixture(), backend = f.create(); await backend.load(); await f.save(backend, 1, 'a better card');
    if (failure === 'mr') f.failMr(true); else f.loseCommit();
    await assert.rejects(backend.repository.submit('Session'));
    const failed = await backend.load(); assert.equal(failed.repository!.submissionPending, true); assert.match(failed.files[0].source, /better card/);
    await assert.rejects(f.save(backend, 2, 'another card'), /erneut versuchen/);
    f.failMr(false); const retried = await backend.repository.submit('Session');
    assert.equal(f.requests.filter(body => body.actions).length, 1); assert.equal(f.mrs.length, 1); assert.equal(retried.repository!.changes.length, 0); backend.disconnect();
  }
});
test('rejected commits and revoked membership preserve drafts and do not create an MR', async () => {
  const f = fixture(), backend = f.create(); await backend.load(); await f.save(backend, 1, 'a better card');
  f.rejectCommit(true); await assert.rejects(backend.repository.submit('Rejected')); assert.equal((await backend.load()).repository!.submissionPending, false);
  assert.equal(f.mrs.length, 0); f.rejectCommit(false); f.role(20);
  await assert.rejects(backend.repository.submit('No permission'), /Schreibrechte/); assert.match((await backend.load()).files[0].source, /better card/); backend.disconnect();
});
test('closed or merged shared sessions return to target only when clean, preserving dirty drafts', async () => {
  for (const dirty of [false, true]) {
    const f = fixture(), backend = f.create(); await backend.load(); await f.save(backend, 1, 'a better card'); await backend.repository.submit('Session');
    if (dirty) await f.save(backend, 2, 'a local card'); f.mrs[0].state = 'closed';
    const state = await backend.load();
    if (dirty) { assert.equal(state.repository!.conflict, true); assert.match(state.files[0].source, /local card/); }
    else { assert.equal(state.repository!.mergeRequest, undefined); assert.equal(state.files[0].source, f.source); }
    backend.disconnect();
  }
});

test('conflict resolution retains local document edits on top of the fresh shared checkpoint', async () => {
  const f = fixture(), one = f.create(), two = f.create(); await one.load(); await f.save(one, 1, 'a better card'); await one.repository.submit('Session');
  await two.load(); await two.repository.join(1);
  await f.save(one, 2, 'a team card'); await f.save(two, 2, 'my own card'); await one.repository.submit('Team'); await two.load();
  const resolved = await two.repository.resolveConflict();
  assert.match(resolved.files[0].source, /my own card/); assert.equal(resolved.repository!.conflict, false); assert.equal(resolved.files[0].version, 4);
  assert.match(resolved.repository!.changes[0].before, /a team card/);
  await two.repository.submit('Resolved'); assert.equal(f.mrs.length, 1); one.disconnect(); two.disconnect();
});

test('local drafts survive reload after membership verification and never persist access credentials', async () => {
  const f = fixture(), store = new MemoryDraftStore(), first = f.create(store); await first.load(); await f.save(first, 1, 'a local card'); first.disconnect();
  const reloaded = f.create(store), state = await reloaded.load();
  assert.match(state.files[0].source, /a local card/); assert.equal(state.files[0].version, 2); assert.equal(state.repository!.changes.length, 1);
  assert.equal(f.requests.length, 0); assert.ok(!JSON.stringify(await store.read()).includes('test-token')); reloaded.disconnect();
});
test('a persisted interrupted publication can resume after reload without duplicate commits', async () => {
  const f = fixture(), store = new MemoryDraftStore(), first = f.create(store); await first.load(); await f.save(first, 1, 'a local card');
  f.failMr(true); await assert.rejects(first.repository.submit('Session')); first.disconnect();
  const reloaded = f.create(store); assert.equal((await reloaded.load()).repository!.submissionPending, true);
  f.failMr(false); await reloaded.repository.submit('Session');
  assert.equal(f.requests.filter(body => body.actions).length, 1); assert.equal(f.mrs.length, 1); reloaded.disconnect();
});
test('offline local changes survive a remote checkpoint and reload with an explicit conflict', async () => {
  const f = fixture(), store = new MemoryDraftStore(), one = f.create(), two = f.create(store);
  await one.load(); await f.save(one, 1, 'a better card'); await one.repository.submit('Session');
  await two.load(); await two.repository.join(1); await f.save(two, 2, 'an offline card'); two.disconnect();
  await f.save(one, 2, 'a team card'); await one.repository.submit('Team');
  const reloaded = f.create(store), state = await reloaded.load();
  assert.equal(state.repository!.conflict, true); assert.match(state.files[0].source, /an offline card/);
  await reloaded.repository.resolveConflict(); await reloaded.repository.submit('Resolved');
  assert.equal(f.mrs.length, 1); one.disconnect(); reloaded.disconnect();
});
test('failed local storage never reports an unsaved input as saved or writes to GitLab', async () => {
  const f = fixture(); let fail = false;
  const store = new MemoryDraftStore(), write = store.write.bind(store);
  store.write = async value => { if (fail) throw new Error('Storage unavailable'); await write(value); };
  const backend = f.create(store); await backend.load(); fail = true;
  await assert.rejects(f.save(backend, 1, 'lost card'), /Storage unavailable/); fail = false;
  assert.equal((await backend.load()).files[0].source, f.source); assert.equal(f.requests.length, 0); backend.disconnect();
});
test('keeping a local draft preserves other documents added by collaborators', async () => {
  const f = fixture(), one = f.create(), two = f.create(); await one.load(); await f.save(one, 1, 'a better card'); await one.repository.submit('Session');
  await two.load(); await two.repository.join(1); await f.save(two, 2, 'a local card');
  await one.request({ action: 'import', filename: '0001-team.md', source: '# Team decision\n\nStatus: Offen\n', actor: 'Other member' });
  await one.repository.submit('Add ADR'); await two.load();
  const resolved = await two.repository.resolveConflict();
  assert.match(resolved.files.find(file => file.id === 'checkout')!.source, /a local card/);
  assert.ok(resolved.files.some(file => file.filename === '0001-team.md')); await two.repository.submit('Keep local feature');
  assert.equal(f.mrs.length, 1); one.disconnect(); two.disconnect();
});

test('new documents use configured output directories in the MR and existing paths stay unchanged', async () => {
  const f = fixture({ specDirectory: 'acceptance', adrDirectory: 'architecture/decisions' });
  const backend = f.create(); await backend.load();
  await backend.request({ action: 'import', actor: 'Test', filename: 'new.feature', source: 'Feature: New\n  Scenario: First\n    Given a condition\n' });
  await backend.request({ action: 'import', actor: 'Test', filename: 'choice.md', source: '# Choice\n' });
  await backend.repository.submit('Add documents');
  const actions = f.requests.find(body => body.actions)!.actions as { file_path: string; content: string }[];
  assert.ok(actions.some(action => action.file_path === 'acceptance/new.feature'));
  assert.ok(actions.some(action => action.file_path === 'architecture/decisions/choice.md'));
  const manifest = JSON.parse(actions.find(action => action.file_path === 'hoospec/workspace.json')!.content);
  assert.equal(manifest.paths.checkout, 'features/checkout.feature');
  assert.equal(f.branches.get('main'), 'initial'); backend.disconnect();
});
