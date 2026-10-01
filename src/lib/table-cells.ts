import { replaceNode, sourceOf, type SpecNode } from './gherkin';

export type TableCell = { row: number; column: number };
export function tableRows(source: string, node: SpecNode) {
  return sourceOf(source, node).split('\n').flatMap((line, lineIndex) => {
    if (!line.trimStart().startsWith('|')) return [];
    const pipes: number[] = [];
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      if (!escaped && line[i] === '|') pipes.push(i);
      escaped = !escaped && line[i] === '\\';
    }
    const cells = pipes.slice(0, -1).map((start, column) => {
      const end = pipes[column + 1], raw = line.slice(start + 1, end);
      const value = raw.trim().replace(/\\([n|\\])/g, (_, char: string) => char === 'n' ? '\n' : char);
      return { start: start + 1, end, raw, value };
    });
    return [{ lineIndex, line, cells }];
  });
}
export function tableCellValue(source: string, node: SpecNode, cell: TableCell) {
  const target = tableRows(source, node)[cell.row]?.cells[cell.column];
  if (!target) throw new Error('Diese Tabellenzelle ist nicht mehr vorhanden.');
  return target.value;
}
export function replaceTableCell(source: string, node: SpecNode, cell: TableCell, value: string) {
  const row = tableRows(source, node)[cell.row], target = row?.cells[cell.column];
  if (!target) throw new Error('Diese Tabellenzelle ist nicht mehr vorhanden.');
  const encoded = value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/\|/g, '\\|');
  const leading = target.raw.match(/^\s*/)?.[0] || ' ';
  const trailing = ' '.repeat(Math.max(1, target.raw.length - leading.length - encoded.length));
  const lines = sourceOf(source, node).split('\n');
  lines[row.lineIndex] = row.line.slice(0, target.start) + leading + encoded + trailing + row.line.slice(target.end);
  return lines.join('\n');
}

export function insertTableRow(source: string, node: SpecNode, afterRow: number) {
  const rows = tableRows(source, node), row = rows[afterRow];
  if (!row || !Number.isInteger(afterRow)) throw new Error('Diese Tabellenzeile ist nicht mehr vorhanden.');
  const header = rows[0];
  const prefix = row.line.slice(0, row.cells[0].start - 1);
  const blank = prefix + '|' + header.cells.map(cell => ' '.repeat(Math.max(3, cell.raw.length))).join('|') + '|';
  const lines = sourceOf(source, node).split('\n');
  lines.splice(row.lineIndex + 1, 0, blank);
  return replaceNode(source, node, lines.join('\n'));
}

export function deleteTableRow(source: string, node: SpecNode, rowIndex: number) {
  if (!Number.isInteger(rowIndex) || rowIndex <= 0) throw new Error('Die Spaltenüberschriften bleiben erhalten.');
  const row = tableRows(source, node)[rowIndex];
  if (!row) throw new Error('Diese Tabellenzeile ist nicht mehr vorhanden.');
  const lines = sourceOf(source, node).split('\n');
  lines.splice(row.lineIndex, 1);
  return replaceNode(source, node, lines.join('\n'));
}
