import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFromSource, renderDocument, validateDocument, isJsonNode, type JsonContent, type JsonNode } from '../src/lib/json-document';
import { importDocument } from '../src/lib/document-import';
import { migrateWorkspace } from '../src/lib/workspace-migration';
import { seed } from '../src/lib/seed';
import { createAdr, parseAdr } from '../src/lib/adr';
import { inlineSource } from '../src/lib/inline-source';
import { sourceOf, replaceNode } from '../src/lib/gherkin';

function nodes(node: JsonNode): JsonNode[] { return [node, ...node.content.filter(isJsonNode).flatMap(nodes)]; }
function blocks(items: JsonContent[]): JsonContent[] { return items.flatMap(item => isJsonNode(item) ? [item, ...blocks(item.before), ...blocks(item.content)] : [item]); }

test('structured feature JSON regenerates exact imports, including attachments, tags, comments and line endings', () => {
  const fixtures = [...seed.files.map(file => file.source), '# language: de\r\n@eins  @zwei\r\nFunktionalität: Anmeldung\r\n  Szenario: Erfolg\r\n    Angenommen ein Konto\r\n    Dann klappt es\r\n',
    '# Before\nFeature: Rich  \n  Scenario: Attachments\n    Given a table\n      | key   | value          |\n      | a\\|b | x\\\\y\\nz      |\n      |       | \\q             |\n    When text is supplied\n      """text\n      # not a comment\n      @not-a-tag\n      | not a table |\n      """\n    Then it succeeds\n\n# After\n'];
  for (const source of fixtures) {
    const document = documentFromSource(source, 'sample.feature');
    assert.equal(renderDocument(JSON.parse(JSON.stringify(document))), source);
    assert.equal(renderDocument(validateDocument(document, 'sample.feature')), source);
    assert.equal(Object.hasOwn(document, 'source'), false);
  }
});

test('feature title, steps and decoded table values are directly editable JSON fields', () => {
  const document = documentFromSource(seed.files[0].source, 'checkout.feature');
  document.root.name = 'Ein neuer Titel';
  const step = nodes(document.root).find(node => node.kind === 'step')!;
  step.name = 'ein neuer Ausgangspunkt';
  const table = blocks(document.root.content).find(item => item.kind === 'table');
  assert.ok(table?.kind === 'table');
  table.rows[1].cells[1].value = 'one | two\\three\nfour';
  const source = renderDocument(validateDocument(document, 'checkout.feature'));
  assert.ok(source.includes('Feature: Ein neuer Titel'));
  assert.ok(source.includes('Given ein neuer Ausgangspunkt'));
  assert.ok(source.includes('one \\| two\\\\three\\nfour'));
  assert.ok(source.includes('Scenario Outline: Versandkosten'));
});

test('ADR JSON distinguishes sections, metadata, questions and answer blocks while preserving Markdown', () => {
  const source = '# Decision #\n\n**Status**: Proposed\n\n## Offene Fragen\n\n1. First question?\n  Antwort: First answer.\n  Another line.\n2. Second question?\n\n## Evidence\n\n```md\n# not a heading\n- not a question\n```\n\n## Decision\n\nUndecided.\n';
  const document = documentFromSource(source, 'adr.md');
  assert.equal(renderDocument(document), source);
  const all = nodes(document.root);
  assert.equal(all.filter(node => node.kind === 'adr-question').length, 2);
  const answer = all.find(node => node.kind === 'adr-answer')!;
  assert.equal(answer.name, 'First answer.');
  answer.name = 'Updated answer.';
  assert.equal(renderDocument(validateDocument(document, 'adr.md')), source.replace('First answer.', 'Updated answer.'));
  assert.ok(blocks(document.root.content).some(item => item.kind === 'metadata' && item.value === 'Proposed'));
});

test('answer source ranges can be edited and selected independently without changing the question or siblings', () => {
  const source = createAdr('Independent answers').replace('- Was müssen wir vor der Entscheidung klären?', '- First?\n  Antwort: Original.\n  Details.\n- Second?');
  const question = parseAdr(source).children.find(n => n.name === 'Offene Fragen')!.children[0];
  const answer = question.children[0];
  assert.equal(answer.kind, 'adr-answer');
  assert.equal(sourceOf(source, answer), '  Antwort: Original.\n  Details.');
  const changed = inlineSource(source, answer, 'answer', 'Updated.\nMore detail.');
  assert.equal(changed, source.replace('  Antwort: Original.\n  Details.', '  Antwort: Updated.\n  More detail.'));
  assert.equal(parseAdr(changed).children.find(n => n.name === 'Offene Fragen')!.children[0].name, 'First?');
  assert.equal(replaceNode(source, answer, '  Antwort: Agent update.'), source.replace(sourceOf(source, answer), '  Antwort: Agent update.'));
  const bold = source.replace('Antwort: Original.', '**Antwort:** Original.');
  assert.equal(renderDocument(documentFromSource(bold, 'adr.md')), bold);
  assert.equal(parseAdr(bold).children.find(n => n.name === 'Offene Fragen')!.children[0].children[0].description, 'Original.\nDetails.');
});

test('JSON imports validate schema, document kind and grammar before rendering or saving', () => {
  const document = documentFromSource(createAdr('Imported'), 'adr.md');
  const exported = JSON.stringify({ schemaVersion: 1, filename: 'adr.md', document });
  assert.equal(renderDocument(importDocument('adr.md.json', exported).document), createAdr('Imported'));
  assert.throws(() => importDocument('broken.json', '{'));
  assert.throws(() => importDocument('broken.json', '{}'));
  assert.throws(() => validateDocument(document, 'sample.feature'));
  assert.throws(() => validateDocument({ ...document, schemaVersion: 99 }, 'adr.md'));
  assert.throws(() => validateDocument({ ...document, root: { ...document.root, content: [{ kind: 'unknown' }] } }, 'adr.md'));
  assert.throws(() => validateDocument({ ...document, root: { ...document.root, keyword: 'invalid' } }, 'adr.md'));
  assert.throws(() => validateDocument({ ...document, root: { ...document.root, name: 'a'.repeat(200001) } }, 'adr.md'));
});

test('workspace migration converts documents and all histories without losing versions or source bytes', () => {
  const before = seed.files[0].source, after = before.replace('einfach anfühlt', 'ruhig anfühlt');
  const legacy = { revision: 4, activeFileId: 'checkout', files: [{ ...seed.files[0], source: after, version: 3, reviewed: true }],
    changes: [{ id: 'change', fileId: 'checkout', filename: 'checkout.feature', actor: 'Test', instruction: 'Changed', kind: 'manual', before, after, version: 3, time: '2026-10-01T00:00:00Z' }],
    history: { checkout: { undo: [before], redo: [after] } } };
  const result = migrateWorkspace(legacy);
  assert.ok(result.migrated);
  assert.equal(result.workspace.schemaVersion, 2);
  assert.equal(result.workspace.revision, 4);
  assert.equal(result.workspace.files[0].version, 3);
  assert.equal(result.workspace.files[0].reviewed, true);
  assert.equal(renderDocument(result.workspace.files[0].document), after);
  assert.equal(renderDocument(result.workspace.changes[0].before!), before);
  assert.equal(renderDocument(result.workspace.history!.checkout.undo[0]), before);
  assert.equal(renderDocument(result.workspace.history!.checkout.redo[0]), after);
  assert.equal(JSON.stringify(result.workspace).includes('"source"'), false);
  assert.deepEqual(migrateWorkspace(result.workspace), { workspace: result.workspace, migrated: false });
  assert.throws(() => migrateWorkspace({ ...legacy, schemaVersion: 99 }));
});
