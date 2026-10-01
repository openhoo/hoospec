import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdr, parseAdr, readAdrStatus, setAdrStatus, nextAdrFilename } from '../src/lib/adr';
import { parseDocument } from '../src/lib/document';
import { flattenNodes, replaceNode, sourceOf } from '../src/lib/gherkin';
import { inlineSource, inlineValue } from '../src/lib/inline-source';
import { deleteSpecNode } from '../src/lib/node-edit';
import { normalizeAgentSource, previewAgentSource } from '../src/lib/agent-output';

const source = createAdr('Gemeinsame Bearbeitung', 'Wie bearbeiten mehrere Personen dieselben Dokumente?');

test('new ADRs are open and contain explicit questions, options and an undecided outcome', () => {
  const adr = parseDocument(source, 'adr-0001.md');
  assert.equal(adr.kind, 'adr');
  assert.equal(adr.name, 'Gemeinsame Bearbeitung');
  assert.equal(readAdrStatus(source), 'open');
  assert.deepEqual(adr.children.map(n => n.name), ['Kontext', 'Offene Fragen', 'Optionen', 'Entscheidung', 'Konsequenzen']);
  assert.equal(adr.children[3].description, 'Noch offen.');
  assert.equal(nextAdrFilename(['checkout.feature', 'adr-0009.md', '0011-decision.md']), 'adr-0012.md');
  assert.throws(() => parseAdr('plain text'));
  assert.throws(() => parseAdr('# One\n# Two'));
});

test('ADR status supports imported conventions and preserves the entire decision body', () => {
  for (const metadata of ['Status: Proposed', '**Status:** Draft', '**Status**: Offen', '## Status\n\nProposed']) {
    const original = `# Storage\n\n${metadata}\n\n## Context\n\nAn open question.\n`;
    assert.equal(readAdrStatus(original), 'open');
    const accepted = setAdrStatus(original, 'accepted');
    assert.equal(readAdrStatus(accepted), 'accepted');
    assert.ok(accepted.endsWith('\n\n## Context\n\nAn open question.\n'));
    assert.equal(readAdrStatus(setAdrStatus(accepted, 'rejected')), 'rejected');
    assert.equal(readAdrStatus(setAdrStatus(accepted, 'superseded')), 'superseded');
  }
  assert.equal(readAdrStatus('# Untitled question\n\n## Context\n\nUnresolved.'), 'open');
  assert.equal(readAdrStatus(setAdrStatus('# Untitled question\n\n## Context\n\nUnresolved.', 'accepted')), 'accepted');
  assert.equal(readAdrStatus(setAdrStatus('# Empty status\n\n## Status\n\n## Context\n\nQuestion', 'accepted')), 'accepted');
  assert.throws(() => parseAdr('# Wrong\n\nStatus: made-up'));
});

test('ADR section and title editing preserve metadata, sibling sections and exact outside bytes', () => {
  const adr = parseAdr(source), section = adr.children[0];
  assert.equal(inlineValue(source, section, 'description'), section.description);
  const changed = inlineSource(source, section, 'description', 'New context.\n\n- An unresolved question.');
  assert.equal(changed, source.replace(section.description, 'New context.\n\n- An unresolved question.'));
  assert.equal(inlineSource(source, adr, 'name', 'Storage options'), source.replace('# Gemeinsame Bearbeitung', '# Storage options'));
  const closed = '# Title #\n\nStatus: Offen\n\n## Context ##\n\nBody\n';
  assert.ok(inlineSource(closed, parseAdr(closed), 'name', 'Renamed').startsWith('# Renamed #'));
  assert.equal(deleteSpecNode(source, section), source.replace(sourceOf(source, section), ''));
  assert.throws(() => deleteSpecNode(source, adr));
});

test('ADR hierarchy and code fences remain intact during selected edits and agent normalization', () => {
  const markdown = '# ADR\n\nStatus: Offen\n\n## Options\n\n### One\n\n```sh\n# This is code\necho yes\n```\n\n### Two\n\nAnother idea.\n\n## Outcome\n\nUndecided.\n';
  const adr = parseAdr(markdown);
  assert.deepEqual(adr.children.map(n => n.name), ['Options', 'Outcome']);
  assert.deepEqual(adr.children[0].children.map(n => n.name), ['One', 'Two']);
  const selected = flattenNodes(adr).find(n => n.name === 'One')!;
  const replacement = sourceOf(markdown, selected).replace('echo yes', 'echo maybe');
  assert.equal(normalizeAgentSource(replacement, 'markdown'), replacement);
  assert.equal(previewAgentSource(replacement, 'markdown'), replacement);
  assert.equal(replaceNode(markdown, selected, replacement), markdown.replace('echo yes', 'echo maybe'));
  assert.equal(normalizeAgentSource('Here is the change:\n```markdown\n## Outcome\n\nStill open.\n```', 'markdown'), '## Outcome\n\nStill open.');
});

test('open questions are distinct Markdown list items with exact independent source ranges', () => {
  const markdown = '# ADR\n\nStatus: Offen\n\n## Offene Fragen\n\n- First question?\n- Second question?\n  More detail.\n- Third question?\n\n## Entscheidung\n\nNoch offen.\n';
  const section = parseAdr(markdown).children[0];
  assert.equal(section.description, '');
  assert.equal(section.children.length, 3);
  assert.deepEqual(section.children.map(n => n.kind), ['adr-question', 'adr-question', 'adr-question']);
  assert.equal(section.children[1].name, 'Second question?\nMore detail.');
  assert.equal(sourceOf(markdown, section.children[0]), '- First question?');
  const changed = inlineSource(markdown, section.children[1], 'answer', 'We choose version checks.\nConflicts remain explicit.');
  assert.equal(changed, markdown.replace('- Second question?\n  More detail.', '- Second question?\n  More detail.\n  Antwort: We choose version checks.\n  Conflicts remain explicit.'));
  const updated = parseAdr(changed).children[0].children[1];
  assert.equal(inlineValue(changed, updated, 'answer'), 'We choose version checks.\nConflicts remain explicit.');
  assert.equal(readAdrStatus(changed), 'open');
  assert.equal(inlineSource(changed, updated, 'answer', ''), markdown);
  const renamed = inlineSource(changed, updated, 'question', 'What about conflicts?');
  assert.equal(parseAdr(renamed).children[0].children[1].description, 'We choose version checks.\nConflicts remain explicit.');
});

test('numbered questions ignore nested answer bullets and fenced code', () => {
  const markdown = '# ADR\n\n## Questions\n\n1. First?\n   Answer: Choice A.\n  - Detail\n2. Second?\n\n```text\n- Code, not a question\n```\n\n## Decision\n\nPending.\n';
  const questions = parseAdr(markdown).children[0].children;
  assert.equal(questions.length, 2);
  assert.equal(questions[0].description, 'Choice A.\n- Detail');
  assert.equal(normalizeAgentSource('1. First?\n  Antwort: A.', 'markdown'), '1. First?\n  Antwort: A.');
  assert.equal(deleteSpecNode(markdown, questions[0]), markdown.replace(sourceOf(markdown, questions[0]), ''));
});

test('manual decision commits content and accepted status while retaining all questions', async () => {
  const { recordAdrDecision } = await import('../src/lib/adr');
  const decision = 'Wir behalten einen versionierten Verlauf.\nKonflikte werden sichtbar zurückgewiesen.';
  const changed = recordAdrDecision(source, decision);
  assert.equal(readAdrStatus(changed), 'accepted');
  assert.equal(parseAdr(changed).children.find(n => n.name === 'Entscheidung')?.description, decision);
  assert.equal(parseAdr(changed).children.find(n => n.name === 'Offene Fragen')?.children.length, 1);
  assert.throws(() => recordAdrDecision(source, '   '));
  assert.equal(readAdrStatus(recordAdrDecision('# ADR\n\nStatus: Offen\n\n## Context\n\nQuestion.', decision)), 'accepted');
});
