import test from 'node:test';
import assert from 'node:assert/strict';
import { flattenNodes, parseSpec, replaceNode, sourceOf } from '../src/lib/gherkin';
import { seed } from '../src/lib/seed';

test('all bundled specs parse, including Rule and Scenario Outline', () => {
  for (const file of seed.files) assert.equal(parseSpec(file.source).kind, 'feature');
  assert.ok(flattenNodes(parseSpec(seed.files[2].source)).some(n => n.kind === 'rule'));
  assert.ok(flattenNodes(parseSpec(seed.files[0].source)).some(n => n.kind === 'examples'));
});

test('a step replacement preserves every byte outside the selected source range', () => {
  const source = seed.files[0].source;
  const step = flattenNodes(parseSpec(source)).find(n => n.name === 'wird die Zahlung erfolgreich abgeschlossen')!;
  const changed = replaceNode(source, step, '    Then wird die Zahlung innerhalb von 5 Sekunden erfolgreich abgeschlossen');
  assert.equal(changed, source.replace('    Then wird die Zahlung erfolgreich abgeschlossen', '    Then wird die Zahlung innerhalb von 5 Sekunden erfolgreich abgeschlossen'));
});

test('scenario selections include own tags but never the following scenario tags', () => {
  const source = seed.files[0].source;
  const scenario = flattenNodes(parseSpec(source)).find(n => n.kind === 'scenario')!;
  const selected = sourceOf(source, scenario);
  assert.ok(selected.startsWith('  @happy-path'));
  assert.ok(!selected.includes('@validation'));
  assert.ok(!selected.includes('abgelehnte Zahlung'));
});

test('table and doc string belong to the preceding step', () => {
  const source = `Feature: Attachments\n  Scenario: Rich steps\n    Given a table\n      | key | value |\n      | one | two |\n    When text is supplied\n      """\n      some text\n      """\n    Then it succeeds\n`;
  const steps = flattenNodes(parseSpec(source)).filter(n => n.kind === 'step');
  assert.ok(sourceOf(source, steps[0]).includes('| one | two |'));
  assert.ok(!sourceOf(source, steps[0]).includes('When'));
  assert.ok(sourceOf(source, steps[1]).includes('some text'));
  assert.ok(!sourceOf(source, steps[1]).includes('Then'));
});

test('language dialects and CRLF imports are supported', () => {
  const source = '# language: de\r\nFunktionalität: Anmeldung\r\n  Szenario: Erfolg\r\n    Angenommen ein gültiges Konto\r\n    Wenn die Anmeldung erfolgt\r\n    Dann wird das Dashboard angezeigt\r\n';
  assert.equal(parseSpec(source).name, 'Anmeldung');
  assert.equal(flattenNodes(parseSpec(source)).filter(n => n.kind === 'step').length, 3);
});

test('invalid AI replacement is rejected before it can be persisted', () => {
  const source = seed.files[0].source;
  const scenario = flattenNodes(parseSpec(source)).find(n => n.kind === 'scenario')!;
  assert.throws(() => replaceNode(source, scenario, '  Scenario: Invalid\n    Examples:\n      | mismatched |\n      | one | two |'));
  assert.throws(() => parseSpec('This is not a feature'));
});


test('agent markdown is normalized without importing explanations', async () => {
  const { normalizeAgentSource, previewAgentSource } = await import('../src/lib/agent-output');
  const line = '    Then wird die Zahlung innerhalb von 5 Sekunden erfolgreich abgeschlossen';
  for (const language of ['gherkin', 'Gherkin', 'text', '']) {
    const output = 'Hier ist die Änderung:\n\n```' + language + '\n' + line + '\n```\n\nAlle anderen Zeilen bleiben unverändert.';
    assert.equal(normalizeAgentSource(output), line);
    assert.equal(previewAgentSource(output), line);
  }
  assert.throws(() => normalizeAgentSource('```gherkin\nunfinished'));
  assert.throws(() => normalizeAgentSource('```gherkin\nThen one\n```\n```gherkin\nThen two\n```'));
});


test('agent indentation matches the selected range and preserves nested attachments', async () => {
  const { alignAgentIndent } = await import('../src/lib/agent-output');
  assert.equal(alignAgentIndent('    Then original', '   Then updated'), '    Then updated');
  assert.equal(alignAgentIndent('    Given original', 'Given updated\n  | key |\n  | val |'), '    Given updated\n      | key |\n      | val |');
});

test('feature title and multiline description edits preserve tags and all scenarios', async () => {
  const { inlineValue, inlineSource } = await import('../src/lib/inline-source');
  const source = seed.files[0].source, feature = parseSpec(source);
  assert.equal(inlineValue(source, feature, 'name'), feature.name);
  assert.equal(inlineValue(source, feature, 'description'), 'Kundinnen und Kunden können ihren Warenkorb sicher bezahlen.\nWir machen Kosten transparent und bestätigen jede Bestellung.');
  assert.equal(inlineSource(source, feature, 'name', 'Ein entspannter Einkauf'), source.replace(feature.name, 'Ein entspannter Einkauf'));
  const updated = inlineSource(source, feature, 'description', 'Einfach und sicher bezahlen.\nJede Bestellung wird bestätigt.');
  assert.equal(updated, source.replace('  Kundinnen und Kunden können ihren Warenkorb sicher bezahlen.\n  Wir machen Kosten transparent und bestätigen jede Bestellung.', '  Einfach und sicher bezahlen.\n  Jede Bestellung wird bestätigt.'));
  const currentFeature = parseSpec(updated);
  const again = inlineSource(updated, currentFeature, 'description', 'Sicher bezahlen.');
  assert.equal(again, source.replace('  Kundinnen und Kunden können ihren Warenkorb sicher bezahlen.\n  Wir machen Kosten transparent und bestätigen jede Bestellung.', '  Sicher bezahlen.'));
});

test('table cells edit independently and round-trip escaped pipes, backslashes and newlines', async () => {
  const { tableRows } = await import('../src/lib/table-cells');
  const { inlineSource, inlineValue } = await import('../src/lib/inline-source');
  const source = seed.files[0].source;
  const node = flattenNodes(parseSpec(source)).find(node => node.kind === 'examples')!;
  const changed = inlineSource(source, node, 'cell', '5,90 €', { row: 1, column: 1 });
  assert.equal(changed, source.replace('| 49,00 €   | 4,90 €        |', '| 49,00 €   | 5,90 €        |'));
  const currentNode = flattenNodes(parseSpec(changed)).find(item => item.id === node.id)!;
  const escaped = inlineSource(changed, currentNode, 'cell', 'one | two\\three\nfour', { row: 2, column: 0 });
  const newNode = flattenNodes(parseSpec(escaped)).find(item => item.id === node.id)!;
  assert.equal(inlineValue(escaped, newNode, 'cell', { row: 2, column: 0 }), 'one | two\\three\nfour');
  assert.equal(tableRows(escaped, newNode).length, 3);
  assert.equal(tableRows(escaped, newNode)[2].cells.length, 2);
});


test('inserting a table row preserves surrounding source, indentation and column widths', async () => {
  const { insertTableRow, deleteTableRow, tableRows } = await import('../src/lib/table-cells');
  const source = seed.files[0].source;
  const node = flattenNodes(parseSpec(source)).find(n => n.kind === 'examples')!;
  const changed = insertTableRow(source, node, 1);
  const current = flattenNodes(parseSpec(changed)).find(n => n.id === node.id)!;
  const rows = tableRows(changed, current);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[2].cells.map(c => c.value), ['', '']);
  assert.deepEqual(rows[2].cells.map(c => c.raw.length), rows[0].cells.map(c => c.raw.length));
  assert.equal(rows[2].line.match(/^\s*/)?.[0], '      ');
  assert.equal(deleteTableRow(changed, current, 2), source);
  const underHeader = insertTableRow(source, node, 0);
  assert.equal(tableRows(underHeader, flattenNodes(parseSpec(underHeader)).find(n => n.id === node.id)!)[1].cells[0].value, '');
});

test('deleting data rows preserves the header and allows an empty table body', async () => {
  const { deleteTableRow, insertTableRow, tableRows } = await import('../src/lib/table-cells');
  const source = seed.files[0].source;
  const node = flattenNodes(parseSpec(source)).find(n => n.kind === 'examples')!;
  assert.throws(() => deleteTableRow(source, node, 0));
  assert.throws(() => deleteTableRow(source, node, 10));
  let changed = deleteTableRow(source, node, 2);
  let current = flattenNodes(parseSpec(changed)).find(n => n.id === node.id)!;
  changed = deleteTableRow(changed, current, 1);
  current = flattenNodes(parseSpec(changed)).find(n => n.id === node.id)!;
  assert.equal(tableRows(changed, current).length, 1);
  const restored = insertTableRow(changed, current, 0);
  assert.equal(tableRows(restored, flattenNodes(parseSpec(restored)).find(n => n.id === node.id)!).length, 2);
});

test('row insertion and deletion leave escaped cell contents intact', async () => {
  const { insertTableRow, deleteTableRow, tableRows } = await import('../src/lib/table-cells');
  const { inlineSource } = await import('../src/lib/inline-source');
  const original = seed.files[0].source;
  const node = flattenNodes(parseSpec(original)).find(n => n.kind === 'examples')!;
  const source = inlineSource(original, node, 'cell', 'one | two\\three\nfour', { row: 1, column: 0 });
  const current = flattenNodes(parseSpec(source)).find(n => n.id === node.id)!;
  const changed = insertTableRow(source, current, 1);
  const updated = flattenNodes(parseSpec(changed)).find(n => n.id === node.id)!;
  assert.equal(tableRows(changed, updated)[1].cells[0].value, 'one | two\\three\nfour');
  assert.equal(deleteTableRow(changed, updated, 2), source);
});


test('hover deletion removes only the selected step and its attachments', async () => {
  const { deleteSpecNode, insertStepAfter } = await import('../src/lib/node-edit');
  const source = seed.files[0].source;
  const nodes = flattenNodes(parseSpec(source));
  const step = nodes.find(n => n.keyword === 'And')!;
  const changed = deleteSpecNode(source, step);
  assert.equal(changed, source.replace(sourceOf(source, step), ''));
  assert.equal(flattenNodes(parseSpec(changed)).filter(n => n.kind === 'step').length, nodes.filter(n => n.kind === 'step').length - 1);
  const inserted = insertStepAfter(source, step);
  assert.ok(inserted.includes(sourceOf(source, step) + '\n    And neuer Schritt'));
  assert.throws(() => deleteSpecNode(source, parseSpec(source)));
  const attached = 'Feature: Data\n  Scenario: Input\n    Given a table\n      | a |\n      | b |\n    Then done\n';
  const selected = flattenNodes(parseSpec(attached)).find(n => n.kind === 'step')!;
  assert.ok(!deleteSpecNode(attached, selected).includes('|'));
});

test('deleting complete scenarios, rules and tables preserves valid surrounding Gherkin', async () => {
  const { deleteSpecNode } = await import('../src/lib/node-edit');
  for (const kind of ['scenario', 'background', 'examples', 'rule']) {
    const source = kind === 'rule' ? seed.files[2].source : seed.files[0].source;
    const node = flattenNodes(parseSpec(source)).find(n => n.kind === kind)!;
    const changed = deleteSpecNode(source, node);
    assert.equal(changed, source.replace(sourceOf(source, node), ''));
    assert.equal(parseSpec(changed).kind, 'feature');
  }
});


test('Backspace resolves the visible selection even when the empty agent input has focus', async () => {
  const { structuralTarget } = await import('../src/lib/editor-target');
  const nodes = flattenNodes(parseSpec(seed.files[0].source));
  const selected = nodes.find(n => n.keyword === 'And')!;
  const hovered = nodes.find(n => n.keyword === 'Then')!;
  const context = { selected, hovered, hoveredRow: null, fileId: 'checkout', input: 'command' as const, commandText: '', editing: false };
  assert.deepEqual(structuralTarget(context), { kind: 'node', node: selected });
  assert.equal(structuralTarget({ ...context, commandText: 'Change this' }), null);
  assert.equal(structuralTarget({ ...context, input: 'editor' }), null);
  assert.equal(structuralTarget({ ...context, editing: true }), null);
  assert.deepEqual(structuralTarget({ ...context, selected: undefined, input: 'none' }), { kind: 'node', node: hovered });
  assert.equal(structuralTarget({ ...context, selected: undefined }), null);
});

test('table row deletion agrees with selected scope and protects the header', async () => {
  const { structuralTarget } = await import('../src/lib/editor-target');
  const nodes = flattenNodes(parseSpec(seed.files[0].source));
  const table = nodes.find(n => n.kind === 'examples')!;
  const step = nodes.find(n => n.kind === 'step')!;
  const context = { selected: table, hovered: table, hoveredRow: { fileId: 'checkout', nodeId: table.id, row: 1 }, fileId: 'checkout', input: 'command' as const, commandText: '', editing: false };
  assert.deepEqual(structuralTarget(context), { kind: 'row', node: table, row: 1 });
  assert.equal(structuralTarget({ ...context, hoveredRow: { ...context.hoveredRow, row: 0 } }), null);
  assert.deepEqual(structuralTarget({ ...context, selected: step }), { kind: 'node', node: step });
  assert.deepEqual(structuralTarget({ ...context, hoveredRow: null }), { kind: 'node', node: table });
});
