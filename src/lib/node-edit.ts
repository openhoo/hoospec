import { parseSpec, replaceNode, sourceOf, type SpecNode } from './gherkin';

export function deleteSpecNode(source: string, node: SpecNode) {
  if (node.kind === 'feature' || node.kind === 'adr') throw new Error('Das Dokument bleibt als Rahmen erhalten. Seine Bereiche kannst du einzeln löschen.');
  return replaceNode(source, node, '');
}

export function insertStepAfter(source: string, node: SpecNode) {
  if (node.kind !== 'step') throw new Error('Bitte einen Schritt auswählen.');
  const lines = source.split('\n');
  const indent = sourceOf(source, node).match(/^\s*/)?.[0] || '    ';
  // Reuse the dialect keyword so German and other imported specs stay valid.
  lines.splice(node.end, 0, `${indent}${node.keyword} neuer Schritt`);
  const result = lines.join('\n');
  parseSpec(result);
  return result;
}
