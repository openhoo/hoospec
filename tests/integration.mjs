import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { renderDocument } from '../src/lib/json-document.ts';
import { seed } from '../src/lib/seed.ts';

const dir = await mkdtemp(path.join(tmpdir(), 'hoospec-test-'));
const legacySeed = { ...seed, history: { checkout: { undo: [], redo: [] } } };
await writeFile(path.join(dir, 'workspace.json'), JSON.stringify(legacySeed));
const base = 'http://127.0.0.1:3411';
let server;
const mock = createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const payload = JSON.parse(text);
  assert.equal(payload.stream, true);
  const message = payload.messages[1].content;
  const request = { request: message.split('Änderungswunsch: ')[1].split('\n\n')[0], selection: { source: message.split(/Ausgewählter Bereich \(.*?\):\n/)[1].split('\n\nÄnderungswunsch:')[0] } };
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (request.request === 'slow') await new Promise(resolve => setTimeout(resolve, 1200));
  const content = request.request === 'invalid' ? 'NOT A VALID FEATURE' : request.request === 'ADR context' ? request.selection.source.replace('An open question.', 'A clearly described open question.') : request.request === 'ADR remove answer marker' ? 'Unmarked answer' : request.request === 'ADR revise answer' ? request.selection.source.replace('Use optimistic version checks.', 'Reject stale versions and preserve current content.') : request.request === 'ADR answer' ? request.selection.source + '\n  Antwort: Use optimistic version checks.' : request.request === 'ADR status' ? request.selection.source.replace('Status: Offen', 'Status: Angenommen') : request.selection.source.replace('erfolgreich abgeschlossen', 'innerhalb von 5 Sekunden erfolgreich abgeschlossen');
  const output = request.request === 'ADR context' ? '```markdown\n' + content + '\n```' : request.request === 'Make timing explicit' ? 'Hier ist die Änderung:\n\n```gherkin\n' + content + '\n```\n\nAlle anderen Schritte bleiben unverändert.' : content;
  for (const part of [output.slice(0, 55), output.slice(55)]) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  if (request.request === 'truncated') return res.end();
  if (request.request === 'length') return res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`);
  if (request.request === 'crlf') {
    res.write('data: [DONE]\r');
    await new Promise(resolve => setTimeout(resolve, 30));
    return res.end('\n');
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(resolve => mock.listen(3412, '127.0.0.1', resolve));
const json = async () => (await fetch(`${base}/api/workspace`)).json();
const post = (body, route = 'workspace', origin = base) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ actor: 'Integration test', ...body }) });
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log(`✓ ${name}`); }

try {
  server = spawn(process.execPath, ['scripts/start.mjs'], { cwd: process.cwd(), env: { ...process.env, HOOSPEC_PORT: '3411', HOOSPEC_HOST: '127.0.0.1', HOOSPEC_DATA_DIR: dir, HOOSPEC_AI_KEY: 'test-only-not-a-real-key', HOOSPEC_AI_MODEL: 'test-model', HOOSPEC_AI_BASE_URL: 'http://127.0.0.1:3412', HOOSPEC_PAGES_ORIGIN: 'http://pages.test', HOOSPEC_REPOSITORY_AGENT_TOKEN: 'test-only-agent-bridge-token-long-enough' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  server.stderr.on('data', chunk => { logs += chunk; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok((await fetch(base)).ok, logs);
  let workspace = await json();
  const original = workspace.files.find(f => f.id === 'checkout');
  await check('legacy workspace migrates once with original backup and exact generated content', async () => {
    const disk = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(disk.schemaVersion, 2);
    assert.equal(Object.hasOwn(disk.files[0], 'source'), false);
    assert.equal(renderDocument(disk.files[0].document), seed.files[0].source);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'workspace.v1.backup.json'), 'utf8')), legacySeed);
    const state = await json();
    assert.equal(state.files[0].source, seed.files[0].source);
    assert.deepEqual(state.files[0].document, disk.files[0].document);
  });
  await check('Pages agent bridge requires exact origin and dedicated authentication', async () => {
    const endpoint = `${base}/api/repository-agent`;
    assert.equal((await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'http://untrusted.test' } })).status, 403);
    const preflight = await fetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'http://pages.test' } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://pages.test');
    const response = await fetch(endpoint, { method: 'POST', headers: { Origin: 'http://pages.test', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401);
  });
  await check('Pages agent streams a validated replacement without touching the server workspace', async () => {
    const before = await json();
    for (const instruction of ['Make timing explicit', 'truncated', 'invalid']) {
      const response = await fetch(`${base}/api/repository-agent`, { method: 'POST', headers: { Origin: 'http://pages.test', Authorization: 'Bearer test-only-agent-bridge-token-long-enough', 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: original.filename, source: original.source, nodeId: 'step:15', instruction }) });
      assert.equal(response.status, 200);
      const stream = await response.text();
      assert.ok(stream.includes(instruction === 'Make timing explicit' ? 'event: complete' : 'event: error'), stream);
    }
    assert.deepEqual((await json()).files, before.files);
  });
  await check('presence is shared and version-independent', async () => {
    assert.equal((await post({ action: 'presence', participantId: 'person-a' })).status, 200);
    assert.equal((await post({ action: 'presence', participantId: 'person-b', actor: 'Second participant' })).status, 200);
    const state = await json();
    assert.equal(state.participants.length, 2);
    assert.equal(state.files[0].version, 1);
  });
  await check('cross-origin writes are rejected', async () => {
    assert.equal((await post({ action: 'navigate', fileId: 'search' }, 'workspace', 'https://untrusted.example')).status, 403);
    assert.equal((await json()).activeFileId, 'checkout');
  });
  await check('shared navigation persists', async () => {
    assert.equal((await post({ action: 'navigate', fileId: 'search' })).status, 200);
    assert.equal((await json()).activeFileId, 'search');
  });
  await check('disconnecting a live server agent cancels generation and preserves saved data', async () => {
    const before = await json(), abort = new AbortController();
    const response = await fetch(`${base}/api/agent`, { method: 'POST', signal: abort.signal, headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: 'checkout', version: 1, nodeId: 'step:15', instruction: 'slow', actor: 'Integration test' }) });
    const reader = response.body.getReader();
    assert.equal((await reader.read()).done, false);
    abort.abort(); await reader.cancel().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 1600));
    const after = await json();
    assert.deepEqual(after.files, before.files); assert.deepEqual(after.changes, before.changes);
    assert.deepEqual(after.drafts, []);
  });
  await check('oversized API payloads are rejected without changing workspace data', async () => {
    const before = await json();
    const response = await fetch(`${base}/api/workspace`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'x'.repeat(2000001) }) });
    assert.equal(response.status, 413); assert.deepEqual((await json()).files, before.files);
  });
  await check('AI streams a targeted edit, saves it, and records provenance', async () => {
    const eventsAbort = new AbortController();
    const events = await fetch(`${base}/api/events`, { signal: eventsAbort.signal });
    const eventsReader = events.body.getReader();
    let eventsText = '';
    const reading = (async () => { try { while (true) { const chunk = await eventsReader.read(); if (chunk.done) break; eventsText += new TextDecoder().decode(chunk.value); } } catch {} })();
    const response = await post({ fileId: 'checkout', version: 1, nodeId: 'step:15', instruction: 'Make timing explicit' }, 'agent');
    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.ok(stream.includes('event: delta'));
    assert.ok(stream.includes('event: complete'), stream);
    await new Promise(resolve => setTimeout(resolve, 100));
    eventsAbort.abort(); await reading;
    const snapshots = eventsText.split('\n\n').filter(frame => frame.startsWith('data:')).map(frame => JSON.parse(frame.slice(5)));
    assert.ok(snapshots.some(state => state.drafts.some(draft => draft.phase === 'writing' && draft.text.includes('Then')) && state.files.find(f => f.id === 'checkout').version === 1), 'Another participant sees the draft before persistence');
    const state = await json();
    assert.deepEqual(state.drafts, []);
    const file = state.files.find(f => f.id === 'checkout');
    assert.equal(file.source, original.source.replace('    Then wird die Zahlung erfolgreich abgeschlossen', '    Then wird die Zahlung innerhalb von 5 Sekunden erfolgreich abgeschlossen'));
    assert.equal(file.version, 2);
    assert.equal(state.changes[0].kind, 'ai');
    assert.equal(state.changes[0].before, original.source);
  });
  await check('split CRLF and unterminated final completion frame persist complete AI output', async () => {
    await post({ action: 'import', filename: 'stream.feature', source: original.source });
    const file = (await json()).files.find(f => f.filename === 'stream.feature');
    const response = await post({ fileId: file.id, version: file.version, nodeId: 'step:15', instruction: 'crlf' }, 'agent');
    const stream = await response.text();
    assert.ok(stream.includes('event: complete'), stream);
    assert.equal((await json()).files.find(f => f.id === file.id).version, 2);
  });
  await check('stale saves return 409 and preserve latest content', async () => {
    assert.equal((await post({ action: 'save', fileId: 'checkout', version: 1, source: original.source })).status, 409);
    assert.equal((await json()).files.find(f => f.id === 'checkout').version, 2);
  });
  await check('invalid AI output cannot alter stored spec', async () => {
    const before = (await json()).files.find(f => f.id === 'checkout');
    const response = await post({ fileId: 'checkout', version: 2, nodeId: 'feature:1', instruction: 'invalid' }, 'agent');
    assert.ok((await response.text()).includes('event: error'));
    assert.deepEqual((await json()).files.find(f => f.id === 'checkout'), before);
  });
  await check('truncated and token-limited AI streams never persist even valid partial content', async () => {
    const before = (await json()).files.find(f => f.id === 'checkout');
    for (const instruction of ['truncated', 'length']) {
      const response = await post({ fileId: before.id, version: before.version, nodeId: 'step:15', instruction }, 'agent');
      const stream = await response.text();
      assert.ok(stream.includes('event: error'), stream);
      assert.ok(!stream.includes('event: complete'));
      assert.deepEqual((await json()).files.find(f => f.id === before.id), before);
    }
  });
  await check('undo restores the original source and is itself recorded', async () => {
    assert.equal((await post({ action: 'undo', fileId: 'checkout', version: 2 })).status, 200);
    const state = await json();
    assert.equal(state.files.find(f => f.id === 'checkout').source, original.source);
    assert.equal(state.changes[0].kind, 'undo');
  });
  await check('manual edits during AI work prevent stale AI overwrite', async () => {
    const response = await post({ fileId: 'checkout', version: 3, nodeId: 'step:15', instruction: 'slow' }, 'agent');
    const manual = original.source.replace('Feature: Ein Einkauf, der sich einfach anfühlt', 'Feature: Von einem Menschen bearbeitet');
    assert.equal((await post({ action: 'save', fileId: 'checkout', version: 3, source: manual })).status, 200);
    const stream = await response.text();
    assert.ok(stream.includes('event: error'), stream);
    assert.equal((await json()).files.find(f => f.id === 'checkout').source, manual);
  });
  await check('invalid imports and duplicate filenames are rejected', async () => {
    assert.equal((await post({ action: 'import', filename: '../escape.feature', source: original.source })).status, 400);
    assert.equal((await post({ action: 'import', filename: 'checkout.feature', source: original.source })).status, 400);
    assert.equal((await post({ action: 'import', filename: 'invalid.feature', source: 'invalid' })).status, 400);
    assert.equal((await json()).files.length, 4);
  });
  await check('import, export and disk readback contain the actual spec', async () => {
    assert.equal((await post({ action: 'import', filename: 'new.feature', source: original.source })).status, 200);
    const state = await json(), file = state.files.find(f => f.filename === 'new.feature');
    const response = await fetch(`${base}/api/export?id=${file.id}`);
    assert.equal(await response.text(), original.source);
    assert.ok(response.headers.get('content-disposition').includes('new.feature'));
    const persisted = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(renderDocument(persisted.files.find(f => f.id === file.id).document), original.source);
    assert.equal(Object.hasOwn(persisted.files.find(f => f.id === file.id), 'source'), false);
  });
  await check('review state persists and reopens after edit', async () => {
    assert.equal((await post({ action: 'review', fileId: 'checkout', version: 4 })).status, 200);
    let file = (await json()).files.find(f => f.id === 'checkout');
    assert.ok(file.reviewed);
    assert.equal((await post({ action: 'save', fileId: file.id, version: file.version, source: original.source })).status, 200);
    file = (await json()).files.find(f => f.id === 'checkout');
    assert.equal(file.reviewed, false);
  });
  await check('multiple undo/redo steps persist and a new edit clears redo', async () => {
    await post({ action: 'import', filename: 'history.feature', source: original.source });
    let file = (await json()).files.find(file => file.filename === 'history.feature');
    const id = file.id;
    const one = original.source.replace('einfach anfühlt', 'übersichtlich anfühlt');
    const two = original.source.replace('einfach anfühlt', 'ruhig anfühlt');
    await post({ action: 'save', fileId: id, version: 1, source: one });
    await post({ action: 'save', fileId: id, version: 2, source: two });
    await post({ action: 'undo', fileId: id, version: 3 });
    assert.equal((await json()).files.find(file => file.id === id).source, one);
    await post({ action: 'undo', fileId: id, version: 4 });
    assert.equal((await json()).files.find(file => file.id === id).source, original.source);
    assert.equal((await post({ action: 'redo', fileId: id, version: 4 })).status, 409);
    await post({ action: 'redo', fileId: id, version: 5 });
    assert.equal((await json()).files.find(file => file.id === id).source, one);
    await post({ action: 'redo', fileId: id, version: 6 });
    assert.equal((await json()).files.find(file => file.id === id).source, two);
    await post({ action: 'undo', fileId: id, version: 7 });
    await post({ action: 'save', fileId: id, version: 8, source: original.source });
    assert.equal((await post({ action: 'redo', fileId: id, version: 9 })).status, 409);
    const disk = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.deepEqual(disk.history[id].redo, []);
    assert.equal(renderDocument(disk.history[id].undo.at(-1)), one);
  });

  const adrSource = '# Shared editing\n\nStatus: Offen\n\n## Context\n\nAn open question.\n\n## Decision\n\nUndecided.\n';
  let adrFile;
  await check('Markdown ADRs import as open documents, export exactly, and validate their title and status', async () => {
    assert.equal((await post({ action: 'import', filename: 'adr-0001.md', source: adrSource })).status, 200);
    adrFile = (await json()).files.find(f => f.filename === 'adr-0001.md');
    assert.equal((await json()).activeFileId, adrFile.id);
    assert.equal(await (await fetch(`${base}/api/export?id=${adrFile.id}`)).text(), adrSource);
    assert.equal((await post({ action: 'import', filename: 'adr-invalid.md', source: 'Missing heading' })).status, 400);
    assert.equal((await post({ action: 'import', filename: 'adr-invalid.md', source: '# Title\n\nStatus: Random' })).status, 400);
    assert.equal((await post({ action: 'adr-status', fileId: 'checkout', version: (await json()).files.find(f => f.id === 'checkout').version, status: 'accepted' })).status, 400);
  });
  await check('ADR lifecycle is versioned, distinct from review, and supports persistent undo/redo', async () => {
    assert.equal((await post({ action: 'review', fileId: adrFile.id, version: 1 })).status, 200);
    let current = (await json()).files.find(f => f.id === adrFile.id);
    assert.equal(current.reviewed, true);
    assert.equal(current.source, adrSource);
    assert.equal((await post({ action: 'adr-status', fileId: adrFile.id, version: current.version, status: 'accepted' })).status, 200);
    current = (await json()).files.find(f => f.id === adrFile.id);
    assert.equal(current.source, adrSource.replace('Status: Offen', 'Status: Angenommen'));
    assert.equal((await post({ action: 'adr-status', fileId: adrFile.id, version: 1, status: 'open' })).status, 409);
    assert.equal((await post({ action: 'adr-status', fileId: adrFile.id, version: current.version, status: 'bogus' })).status, 400);
    await post({ action: 'undo', fileId: adrFile.id, version: current.version });
    current = (await json()).files.find(f => f.id === adrFile.id);
    assert.equal(current.source, adrSource);
    await post({ action: 'redo', fileId: adrFile.id, version: current.version });
    current = (await json()).files.find(f => f.id === adrFile.id);
    assert.ok(current.source.includes('Status: Angenommen'));
    await post({ action: 'undo', fileId: adrFile.id, version: current.version });
    adrFile = (await json()).files.find(f => f.id === adrFile.id);
    const disk = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(renderDocument(disk.files.find(f => f.id === adrFile.id).document), adrSource);
  });
  await check('ADR agent edits only its selected Markdown section and keeps undecided status', async () => {
    const line = adrFile.source.split('\n').indexOf('## Context') + 1;
    const response = await post({ fileId: adrFile.id, version: adrFile.version, nodeId: `adr-section:${line}`, instruction: 'ADR context' }, 'agent');
    const stream = await response.text();
    assert.ok(stream.includes('event: delta'));
    assert.ok(stream.includes('event: complete'), stream);
    adrFile = (await json()).files.find(f => f.id === adrFile.id);
    assert.equal(adrFile.source, adrSource.replace('An open question.', 'A clearly described open question.'));
    assert.equal((await json()).drafts.length, 0);
    const attemptedStatus = await post({ fileId: adrFile.id, version: adrFile.version, nodeId: 'adr:1', instruction: 'ADR status' }, 'agent');
    assert.ok((await attemptedStatus.text()).includes('event: error'));
    assert.equal((await json()).files.find(f => f.id === adrFile.id).source, adrFile.source);
    const invalid = await post({ fileId: adrFile.id, version: adrFile.version, nodeId: 'adr:1', instruction: 'invalid' }, 'agent');
    assert.ok((await invalid.text()).includes('event: error'));
    assert.equal((await json()).files.find(f => f.id === adrFile.id).source, adrFile.source);
  });
  let questionsFile;
  const questionsSource = '# Questions\n\nStatus: Offen\n\n## Offene Fragen\n\n- How do we detect conflicts?\n- What history do we need?\n\n## Entscheidung\n\nNoch offen.\n';
  await check('individual agent and manual answers preserve siblings, status and persistent history', async () => {
    assert.equal((await post({ action: 'import', filename: 'adr-questions.md', source: questionsSource })).status, 200);
    questionsFile = (await json()).files.find(f => f.filename === 'adr-questions.md');
    const line = questionsSource.split('\n').indexOf('- How do we detect conflicts?') + 1;
    const result = await post({ fileId: questionsFile.id, version: questionsFile.version, nodeId: `adr-question:${line}`, instruction: 'ADR answer' }, 'agent');
    assert.ok((await result.text()).includes('event: complete'));
    questionsFile = (await json()).files.find(f => f.id === questionsFile.id);
    const aiSource = questionsSource.replace('- How do we detect conflicts?', '- How do we detect conflicts?\n  Antwort: Use optimistic version checks.');
    assert.equal(questionsFile.source, aiSource);
    const manualSource = aiSource.replace('- What history do we need?', '- What history do we need?\n  Antwort: Record actor, reason and source changes.');
    assert.equal((await post({ action: 'save', fileId: questionsFile.id, version: questionsFile.version, source: manualSource })).status, 200);
    questionsFile = (await json()).files.find(f => f.id === questionsFile.id);
    await post({ action: 'undo', fileId: questionsFile.id, version: questionsFile.version });
    questionsFile = (await json()).files.find(f => f.id === questionsFile.id);
    assert.equal(questionsFile.source, aiSource);
    await post({ action: 'redo', fileId: questionsFile.id, version: questionsFile.version });
    questionsFile = (await json()).files.find(f => f.id === questionsFile.id);
    assert.equal(questionsFile.source, manualSource);
    const disk = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(renderDocument(disk.files.find(f => f.id === questionsFile.id).document), manualSource);
  });
  await check('manual decisions atomically commit status and text, reject stale/blank requests and undo together', async () => {
    const before = questionsFile.source;
    const version = questionsFile.version;
    assert.equal((await post({ action: 'adr-decision', fileId: questionsFile.id, version, decision: '   ' })).status, 400);
    assert.equal((await json()).files.find(f => f.id === questionsFile.id).source, before);
    assert.equal((await post({ action: 'adr-decision', fileId: questionsFile.id, version, decision: 'We choose version checks and an explicit history.' })).status, 200);
    questionsFile = (await json()).files.find(f => f.id === questionsFile.id);
    const decided = before.replace('Status: Offen', 'Status: Angenommen').replace('Noch offen.', 'We choose version checks and an explicit history.');
    assert.equal(questionsFile.source, decided);
    assert.equal((await post({ action: 'adr-decision', fileId: questionsFile.id, version, decision: 'Stale decision' })).status, 409);
    assert.equal((await json()).files.find(f => f.id === questionsFile.id).source, decided);
    await post({ action: 'undo', fileId: questionsFile.id, version: questionsFile.version });
    questionsFile = (await json()).files.find(f => f.id === questionsFile.id);
    assert.equal(questionsFile.source, before);
    await post({ action: 'redo', fileId: questionsFile.id, version: questionsFile.version });
    const disk = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(renderDocument(disk.files.find(f => f.id === questionsFile.id).document), decided);
  });
  await check('answer-only AI updates preserve question text, sibling answers and status', async () => {
    const source = questionsFile.source;
    const line = source.split('\n').findIndex(line => line.includes('Antwort: Use optimistic version checks.')) + 1;
    const response = await post({ fileId: questionsFile.id, version: (await json()).files.find(f => f.id === questionsFile.id).version, nodeId: `adr-answer:${line}`, instruction: 'ADR revise answer' }, 'agent');
    assert.ok((await response.text()).includes('event: complete'));
    const file = (await json()).files.find(f => f.id === questionsFile.id);
    assert.equal(file.source, source.replace('Use optimistic version checks.', 'Reject stale versions and preserve current content.').replace('Status: Offen', 'Status: Angenommen').replace('Noch offen.', 'We choose version checks and an explicit history.'));
    const invalid = await post({ fileId: file.id, version: file.version, nodeId: `adr-answer:${line}`, instruction: 'ADR remove answer marker' }, 'agent');
    assert.ok((await invalid.text()).includes('event: error'));
    assert.equal((await json()).files.find(f => f.id === file.id).source, file.source);
    const disk = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(disk.changes[0].kind, 'ai');
    assert.equal(typeof disk.changes[0].after, 'object');
    assert.equal(renderDocument(disk.changes[0].after), file.source);
  });
  await check('structured JSON saves generate exports, persist JSON history and reject stale or invalid documents', async () => {
    const document = structuredClone(original.document);
    assert.equal((await post({ action: 'import', filename: 'json-managed.feature', document })).status, 200);
    let file = (await json()).files.find(f => f.filename === 'json-managed.feature');
    document.root.name = 'Direkt aus JSON';
    assert.equal((await post({ action: 'save-document', fileId: file.id, version: file.version, document, source: 'Ignored text must never become the authority.' })).status, 200);
    file = (await json()).files.find(f => f.id === file.id);
    const expected = original.source.replace('Ein Einkauf, der sich einfach anfühlt', 'Direkt aus JSON');
    assert.equal(file.source, expected);
    assert.equal(await (await fetch(`${base}/api/export?id=${file.id}`)).text(), expected);
    assert.equal((await post({ action: 'save-document', fileId: file.id, version: 1, document: original.document })).status, 409);
    assert.equal((await post({ action: 'save-document', fileId: file.id, version: file.version, document: { ...document, root: { ...document.root, keyword: 'Invalid' } } })).status, 400);
    assert.equal((await post({ action: 'save-document', fileId: file.id, version: file.version, document: { ...document, kind: 'adr' } })).status, 400);
    assert.equal((await post({ action: 'save-document', fileId: file.id, version: file.version, document: { schemaVersion: 99 } })).status, 400);
    assert.equal((await json()).files.find(f => f.id === file.id).source, expected);
    await post({ action: 'undo', fileId: file.id, version: file.version });
    file = (await json()).files.find(f => f.id === file.id);
    assert.equal(file.source, original.source);
    await post({ action: 'redo', fileId: file.id, version: file.version });
    const disk = JSON.parse(await readFile(path.join(dir, 'workspace.json'), 'utf8'));
    assert.equal(renderDocument(disk.files.find(f => f.id === file.id).document), expected);
    assert.equal(typeof disk.history[file.id].undo[0], 'object');
    assert.equal(JSON.stringify(disk).includes('"source"'), false);
  });
  await check('JSON downloads can be reimported and generate identical Markdown and Gherkin', async () => {
    for (const originalFile of [original, questionsFile]) {
      const current = (await json()).files.find(f => f.id === originalFile.id);
      const response = await fetch(`${base}/api/export?id=${current.id}&format=json`);
      assert.ok(response.headers.get('content-type').includes('application/json'));
      const exported = await response.json();
      assert.equal(exported.schemaVersion, 1);
      assert.equal(exported.filename, current.filename);
      assert.equal(renderDocument(exported.document), current.source);
      assert.equal(Object.hasOwn(exported, 'source'), false);
      exported.filename = 'copy-' + current.filename;
      assert.equal((await post({ action: 'import', filename: current.filename + '.json', source: JSON.stringify(exported) })).status, 200);
      const copy = (await json()).files.find(f => f.filename === exported.filename);
      assert.equal(copy.source, current.source);
      assert.deepEqual(copy.document, current.document);
    }
    assert.equal((await post({ action: 'import', filename: 'broken.json', source: '{}' })).status, 400);
    assert.equal((await post({ action: 'import', filename: 'invalid.json', source: JSON.stringify({ schemaVersion: 1, filename: '../escape.feature', document: original.document }) })).status, 400);
    assert.equal((await fetch(`${base}/api/export?id=checkout&format=unknown`)).status, 400);
  });
  console.log(`\n${passed} integration checks passed. AI provider is a local test fixture.`);
} finally {
  server?.kill('SIGTERM');
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
