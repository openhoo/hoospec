import { questionParts } from './adr';
import { tableCellValue, replaceTableCell, type TableCell } from './table-cells';
import { replaceNode, sourceOf, type SpecNode } from './gherkin';

export type InlineMode = 'name' | 'description' | 'source' | 'cell' | 'answer' | 'question';
function headerIndex(lines: string[], node: SpecNode) {
  const markdown = node.kind === 'adr' || node.kind === 'adr-section';
  const index = lines.findIndex(line => markdown ? line.replace(/^#+\s+/, '').replace(/\s+#+\s*$/, '').trim() === node.name : line.trimStart().startsWith(node.keyword) && line.trimEnd().endsWith(node.name));
  if (index < 0) throw new Error('Diese Stelle kann nicht direkt bearbeitet werden.');
  return index;
}
function descriptionRange(source: string, node: SpecNode) {
  const lines = sourceOf(source, node).split('\n');
  const header = headerIndex(lines, node);
  let start = header + 1;
  let end = node.children.length ? node.children[0].start - node.start : lines.length;
  while (end > start && !lines[end - 1].trim()) end--;
  if (node.kind === 'adr' || node.kind === 'adr-section') {
    while (start < end && (!lines[start].trim() || (node.kind === 'adr' && /^\s*(Status|Datum|Date)\s*:/i.test(lines[start].replace(/\*/g, ''))))) start++;
  }
  const indent = node.kind === 'adr' || node.kind === 'adr-section' ? '' : lines[start]?.match(/^ */)?.[0] || (lines[header].match(/^ */)![0] + '  ');
  return { lines, start, end, indent };
}
export function inlineValue(source: string, node: SpecNode, mode: InlineMode, cell?: TableCell) {
  if (node.kind === 'adr-answer' && mode === 'answer') return node.description;
  if (mode === 'answer' || mode === 'question') return questionParts(source, node)[mode === 'answer' ? 'answer' : 'question'];
  if (mode === 'cell') { if (!cell) throw new Error('Keine Zelle ausgewählt.'); return tableCellValue(source, node, cell); }
  if (mode === 'name') return node.name;
  if (mode === 'source') return sourceOf(source, node);
  const { lines, start, end, indent } = descriptionRange(source, node);
  return lines.slice(start, end).map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
}
export function inlineSource(source: string, node: SpecNode, mode: InlineMode, value: string, cell?: TableCell) {
  if (node.kind === 'adr-answer' && mode === 'answer') {
    const lines = sourceOf(source, node).split('\n');
    const prefix = lines[0].match(/^(\s+(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:(?:\*\*)?\s*)/i)?.[1] || '  Antwort: ';
    const indent = lines[0].match(/^\s*/)?.[0] || '  ';
    const text = value.trim().split('\n');
    return replaceNode(source, node, [prefix + text[0], ...text.slice(1).map(line => line ? indent + line : '')].join('\n'));
  }
  if (mode === 'answer' || mode === 'question') {
    const parts = questionParts(source, node);
    if (mode === 'question') {
      if (!value.trim()) throw new Error('Die Frage darf nicht leer sein.');
      const text = value.trim().split('\n');
      const replacement = [parts.prefix + text[0], ...text.slice(1).map(line => '  ' + line), ...parts.lines.slice(parts.questionEnd)].join('\n');
      return replaceNode(source, node, replacement);
    }
    const questionLines = parts.lines.slice(0, parts.questionEnd);
    while (questionLines.length > 1 && !questionLines.at(-1)?.trim()) questionLines.pop();
    const text = value.trim();
    const answerLines = text ? text.split('\n').map((line, index) => index === 0 ? `  Antwort: ${line}` : line ? `  ${line}` : '') : [];
    return replaceNode(source, node, [...questionLines, ...answerLines].join('\n'));
  }
  if (mode === 'cell') { if (!cell) throw new Error('Keine Zelle ausgewählt.'); return replaceNode(source, node, replaceTableCell(source, node, cell, value)); }
  if (mode === 'source') return replaceNode(source, node, value);
  if (mode === 'description') {
    const { lines, start, end, indent } = descriptionRange(source, node);
    lines.splice(start, end - start, ...(value ? value.split('\n').map(line => line ? indent + line : '') : []));
    return replaceNode(source, node, lines.join('\n'));
  }
  if (!value.trim() || /[\r\n]/.test(value)) throw new Error('Bitte einen Text in einer Zeile eingeben.');
  const lines = sourceOf(source, node).split('\n');
  const index = headerIndex(lines, node), end = lines[index].trimEnd().length;
  if (node.kind === 'adr' || node.kind === 'adr-section') {
    lines[index] = lines[index].replace(/^(#+\s+)(.*?)(\s+#+\s*)?$/, (_, prefix: string, _name: string, suffix: string) => prefix + value + (suffix || ''));
  } else lines[index] = lines[index].slice(0, end - node.name.length) + value + lines[index].slice(end);
  return replaceNode(source, node, lines.join('\n'));
}
