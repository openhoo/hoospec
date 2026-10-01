import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAdr, readAdrStatus } from '../src/lib/adr';
import { documentFromSource, renderDocument, validateDocument } from '../src/lib/json-document';
import { migrateWorkspace } from '../src/lib/workspace-migration';

test('Markdown fences respect delimiter and length and never expose code as headings or questions', () => {
  const source = '# ADR\n\nStatus: Offen\n\n## Questions\n\n- First?\n  Antwort: Yes.\n  ````md\n  ```\n# Fake title\n- Fake question\n  ~~~\n  ````\n- Second?\n';
  const root = parseAdr(source);
  assert.equal(root.children[0].children.length, 2);
  assert.equal(renderDocument(documentFromSource(source, 'adr.md')), source);
});

test('headings keep literal hashes and status examples inside code never change the lifecycle', () => {
  const source = '# Use C#\n\n```text\nStatus: Accepted\n```\n\n## Context\n\nExample.\n';
  assert.equal(parseAdr(source).name, 'Use C#');
  assert.equal(readAdrStatus(source), 'open');
});

test('answer markers inside fenced question examples remain question text', () => {
  const source = '# ADR\n\n## Questions\n\n- How should this look?\n  ```text\n  Antwort: This is an example.\n  ```\n- Another?\n';
  const question = parseAdr(source).children[0].children[0];
  assert.equal(question.children.length, 0);
  assert.equal(question.description, '');
});

test('JSON schemas reject contradictory node kinds rather than silently reinterpreting them', () => {
  const document = documentFromSource('# ADR\n\n## Context\n\nText.\n', 'adr.md');
  const section = document.root.content.find(item => item.kind === 'adr-section')!;
  section.kind = 'step';
  assert.throws(() => validateDocument(document, 'adr.md'));
});

test('workspace loading validates JSON history before any transaction can rewrite it', () => {
  const document = documentFromSource('# ADR\n', 'adr.md');
  assert.throws(() => migrateWorkspace({ schemaVersion: 2, revision: 1, activeFileId: 'adr', files: [{ id: 'adr', filename: 'adr.md', version: 1, reviewed: false, document }], changes: [], history: { adr: { undo: ['legacy text in v2'], redo: [] } } }));
});

test('unindented prose after the question list is outside the final answer scope', () => {
  const source = '# ADR\n\n## Questions\n\n- First?\n  Antwort: Yes.\n\nThis paragraph is outside the list.\n';
  const question = parseAdr(source).children[0].children[0];
  assert.equal(question.end, 6);
  assert.equal(question.description, 'Yes.');
  assert.equal(renderDocument(documentFromSource(source, 'adr.md')), source);
});
