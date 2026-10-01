import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStreamDecoder } from '../src/lib/event-stream';
import { resolveNode } from '../src/lib/node-anchor';
import { mergeSnapshot } from '../src/lib/snapshot-state';
import { parseAdr, setAdrStatus } from '../src/lib/adr';
import { flattenNodes } from '../src/lib/gherkin';
import { documentFromSource } from '../src/lib/json-document';
import { historyFor, applyChange, restoreHistory } from '../src/lib/store';
import type { Snapshot, Workspace } from '../src/lib/types';

const source = '# ADR\n\nStatus: Offen\n\n## Questions\n\n- First?\n- Second?\n  Antwort: Yes.\n';
const questions = flattenNodes(parseAdr(source)).filter(node => node.kind === 'adr-question');
test('scope follows its sibling when a multiline answer is inserted above it', () => {
  const next = source.replace('- First?', '- First?\n  Antwort: First line.\n  More details.');
  const node = resolveNode(questions[1], source, next, 'adr.md');
  assert.equal(node?.name, 'Second?');
  assert.equal(node?.start, questions[1].start + 2);
});
test('deleted scopes never silently select the next sibling', () => {
  const next = source.replace('- First?\n', '');
  assert.equal(resolveNode(questions[0], source, next, 'adr.md'), undefined);
});
test('an edited scope is rebased only when explicitly requested', () => {
  const next = source.replace('- First?', '- Changed?');
  assert.equal(resolveNode(questions[0], source, next, 'adr.md'), undefined);
  assert.equal(resolveNode(questions[0], source, next, 'adr.md', true)?.name, 'Changed?');
});
test('SSE frames tolerate chunked CRLF, multiline data and final unterminated frames', () => {
  const decoder = new EventStreamDecoder();
  assert.deepEqual(decoder.push('event: delta\r'), []);
  assert.deepEqual(decoder.push('\ndata: one\r\ndata: two\r'), []);
  assert.deepEqual(decoder.push('\n\r'), []);
  assert.deepEqual(decoder.push('\ndata: [DONE]\r'), [{ event: 'delta', data: 'one\ntwo' }]);
  assert.deepEqual(decoder.push('\n', true), [{ event: 'message', data: '[DONE]' }]);
});
test('SSE rejects oversized incomplete frames', () => {
  assert.throws(() => new EventStreamDecoder().push('data: ' + 'x'.repeat(250001)));
});
test('presence updates preserve file references and stale snapshots cannot roll back state', () => {
  const file = { id: 'adr', filename: 'adr.md', source, version: 1, reviewed: false, document: documentFromSource(source, 'adr.md') };
  const current: Snapshot = { schemaVersion: 2, files: [file], activeFileId: file.id, revision: 1, changes: [], participants: [], drafts: [], aiReady: false, model: '' };
  const next = structuredClone(current);
  next.participants = [{ id: 'peer', name: 'Peer', seen: 1 }];
  const merged = mergeSnapshot(current, next);
  assert.equal(merged.files[0], file);
  assert.equal(merged.changes, current.changes);
  assert.equal(merged.participants.length, 1);
  assert.equal(mergeSnapshot(current, { ...next, revision: 0 }), current);
  next.files[0].version++;
  assert.notEqual(mergeSnapshot(current, next).files[0], file);
});
test('bold lifecycle metadata retains wrapping, spacing and CRLF', () => {
  for (const status of ['**Status: Offen**', '**Status:** **Offen**', 'Status: **Offen**', '**Status**: Offen  ']) {
    const before = `# ADR\r\n\r\n${status}\r\n\r\n## Context\r\nText.\r\n`;
    assert.equal(setAdrStatus(before, 'accepted'), before.replace('Offen', 'Angenommen'));
  }
});
test('reserved file identifiers have independent recoverable histories', () => {
  const workspace: Workspace = { schemaVersion: 2, files: [{ id: 'constructor', filename: 'adr.md', document: documentFromSource(source, 'adr.md'), version: 1, reviewed: false }], activeFileId: 'constructor', revision: 1, changes: [] };
  assert.deepEqual(historyFor(workspace, 'constructor'), { undo: [], redo: [] });
  applyChange(workspace, 'constructor', 1, source.replace('First?', 'Changed?'), 'Test', 'Change', 'manual');
  restoreHistory(workspace, 'constructor', 2, 'Test', 'undo');
  assert.equal(historyFor(workspace, 'constructor').redo.length, 1);
});

test('workspace completion frames can exceed the stricter provider frame limit', () => {
  const frame = 'event: complete\ndata: ' + JSON.stringify({ files: [{ source: 'x'.repeat(260000) }] }) + '\n\n';
  assert.throws(() => new EventStreamDecoder().push(frame));
  const events = new EventStreamDecoder(1000000).push(frame);
  assert.equal(events[0].event, 'complete');
  assert.equal(JSON.parse(events[0].data).files[0].source.length, 260000);
});
