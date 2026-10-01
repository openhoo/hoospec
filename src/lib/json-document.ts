import { parseDocument, documentKind } from './document';
import type { SpecNode } from './gherkin';

/** Canonical documents contain editable values and layout, never a whole source blob. */
export type JsonLayout = { indent: string; separator: string; suffix: string };
export type JsonNode = {
  kind: SpecNode['kind']; keyword: string; name: string; layout: JsonLayout;
  before: JsonBlock[]; content: JsonContent[];
};
export type JsonCell = { value: string; leading: string; trailing: string; spelling?: string };
export type JsonBlock =
  | { kind: 'text' | 'blank' | 'comment'; lines: string[] }
  | { kind: 'metadata'; key: string; value: string; layout: JsonLayout }
  | { kind: 'tags'; values: string[]; indent: string; separators: string[]; suffix: string }
  | { kind: 'table'; rows: { cells: JsonCell[]; indent: string; suffix: string }[] }
  | { kind: 'fence' | 'doc-string'; opening: string; lines: string[]; closing: string | null };
export type JsonContent = JsonNode | JsonBlock;
export type JsonDocument = { schemaVersion: 1; kind: 'feature' | 'adr'; newline: '\n' | '\r\n'; preamble: JsonBlock[]; root: JsonNode; trailing: JsonBlock[] };
export type DocumentExport = { schemaVersion: 1; filename: string; document: JsonDocument };
export class DocumentParserError extends Error { name = 'DocumentParserError'; }
const nodeKinds = new Set(['feature', 'rule', 'scenario', 'background', 'step', 'examples', 'adr', 'adr-section', 'adr-question', 'adr-answer']);
export function isJsonNode(item: JsonContent): item is JsonNode { return nodeKinds.has(item.kind); }
const decodeCell = (value: string) => value.replace(/\\([n|\\])/g, (_, char: string) => char === 'n' ? '\n' : char);
const encodeCell = (value: string) => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/\|/g, '\\|');

function tableRow(line: string) {
  const pipes: number[] = []; let escaped = false;
  for (let i = 0; i < line.length; i++) {
    if (!escaped && line[i] === '|') pipes.push(i);
    escaped = !escaped && line[i] === '\\';
  }
  if (pipes.length < 2) throw new DocumentParserError('Ungültige Tabellenzeile.');
  return { indent: line.slice(0, pipes[0]), suffix: line.slice(pipes.at(-1)! + 1), cells: pipes.slice(0, -1).map((start, i) => {
    const raw = line.slice(start + 1, pipes[i + 1]);
    const leading = raw.match(/^\s*/)?.[0] || '';
    const trailing = raw.slice(leading.length).match(/\s*$/)?.[0] || '';
    const spelling = raw.slice(leading.length, raw.length - trailing.length), value = decodeCell(spelling);
    return { value, leading, trailing, ...(encodeCell(value) === spelling ? {} : { spelling }) };
  }) };
}

function blocks(lines: string[], kind: JsonDocument['kind']): JsonBlock[] {
  const result: JsonBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(`{3,}|~{3,}|""")(.*)$/);
    if (fence) {
      const body: string[] = []; let closing: string | null = null;
      while (i + 1 < lines.length) {
        const next = lines[++i];
        if (new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$').test(next)) { closing = next; break; }
        body.push(next);
      }
      result.push({ kind: kind === 'feature' ? 'doc-string' : 'fence', opening: line, lines: body, closing }); continue;
    }
    if (kind === 'feature' && /^\s*\|/.test(line)) {
      const rows = [tableRow(line)];
      while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1])) rows.push(tableRow(lines[++i]));
      result.push({ kind: 'table', rows }); continue;
    }
    if (kind === 'feature' && /^\s*@/.test(line)) {
      const matches = [...line.matchAll(/@[^\s]+/g)];
      result.push({ kind: 'tags', values: matches.map(match => match[0]), indent: line.slice(0, matches[0].index), separators: matches.slice(1).map((match, n) => line.slice(matches[n].index! + matches[n][0].length, match.index)), suffix: line.slice(matches.at(-1)!.index! + matches.at(-1)![0].length) }); continue;
    }
    const metadata = kind === 'adr' && line.match(/^(\s*)(\*\*)?((?:Status|Datum|Date))(\*\*)?(\s*:\s*)(.*?)(\s*)$/i);
    if (metadata) {
      result.push({ kind: 'metadata', key: (metadata[2] || '') + metadata[3] + (metadata[4] || ''), value: metadata[6], layout: { indent: metadata[1], separator: metadata[5], suffix: metadata[7] } }); continue;
    }
    const blockKind = !line.trim() ? 'blank' : /^\s*#/.test(line) && kind === 'feature' ? 'comment' : 'text';
    const previous = result.at(-1);
    if (previous?.kind === blockKind && 'lines' in previous) previous.lines.push(line);
    else result.push({ kind: blockKind, lines: [line] });
  }
  return result;
}

export function documentFromSource(source: string, filename: string): JsonDocument {
  if (source.length > 200000) throw new DocumentParserError('Das Dokument darf maximal 200 KB groß sein.');
  const kind = documentKind(filename);
  const newline = source.includes('\r\n') && !source.replace(/\r\n/g, '').includes('\n') ? '\r\n' : '\n';
  const normalized = newline === '\r\n' ? source.replace(/\r\n/g, '\n') : source;
  const tree = parseDocument(normalized, filename), lines = normalized.split('\n');
  function build(node: SpecNode): JsonNode {
    let headerAt = node.start - 1, keyword = node.keyword, name = node.name;
    let prefix = '', suffix = '';
    if (node.kind === 'adr-question') {
      const match = lines[headerAt].match(/^(\s*)([-*+]|\d+[.)])(\s+)(.*?)(\s*)$/)!;
      keyword = match[2]; name = match[4]; prefix = match[1] + keyword + match[3]; suffix = match[5];
    } else if (node.kind === 'adr-answer') {
      const match = lines[headerAt].match(/^(\s*)((?:\*\*)?(?:Antwort|Answer)(?:\*\*)?)(\s*:(?:\*\*)?\s*)(.*?)(\s*)$/i)!;
      keyword = match[2]; name = match[4]; prefix = match[1] + keyword + match[3]; suffix = match[5];
    } else {
      headerAt = lines.findIndex((line, i) => i >= node.start - 1 && i < node.end && (node.kind === 'adr' || node.kind === 'adr-section' ? line.startsWith(keyword) && /^\s/.test(line.slice(keyword.length)) : line.trimStart().startsWith(keyword) && line.trimEnd().endsWith(name)));
      if (headerAt < 0) throw new DocumentParserError('Dokumentüberschrift konnte nicht gelesen werden.');
      const line = lines[headerAt];
      if (node.kind === 'adr' || node.kind === 'adr-section') {
        prefix = line.match(/^#+\s+/)![0]; suffix = line.slice(prefix.length + name.length);
      } else {
        const nameAt = name ? line.lastIndexOf(name) : line.length;
        prefix = line.slice(0, nameAt); suffix = line.slice(nameAt + name.length);
      }
    }
    const indent = prefix.match(/^\s*/)?.[0] || '';
    const layout = { indent, separator: prefix.slice(indent.length + keyword.length), suffix };
    const content: JsonContent[] = []; let cursor = headerAt + 1;
    for (const child of node.children) {
      content.push(...blocks(lines.slice(cursor, child.start - 1), kind), build(child)); cursor = child.end;
    }
    content.push(...blocks(lines.slice(cursor, node.end), kind));
    return { kind: node.kind, keyword, name, layout, before: blocks(lines.slice(node.start - 1, headerAt), kind), content };
  }
  return { schemaVersion: 1, kind, newline, preamble: blocks(lines.slice(0, tree.start - 1), kind), root: build(tree), trailing: blocks(lines.slice(tree.end), kind) };
}

export function renderDocument(document: JsonDocument): string {
  function render(item: JsonContent): string[] {
    if (isJsonNode(item)) return [...item.before.flatMap(render), item.layout.indent + item.keyword + item.layout.separator + item.name + item.layout.suffix, ...item.content.flatMap(render)];
    if (item.kind === 'metadata') return [item.layout.indent + item.key + item.layout.separator + item.value + item.layout.suffix];
    if (item.kind === 'tags') return [item.indent + item.values.map((value, i) => (i ? item.separators[i - 1] ?? ' ' : '') + value).join('') + item.suffix];
    if (item.kind === 'table') return item.rows.map(row => row.indent + '|' + row.cells.map(cell => cell.leading + (cell.spelling !== undefined && decodeCell(cell.spelling) === cell.value ? cell.spelling : encodeCell(cell.value)) + cell.trailing).join('|') + '|' + row.suffix);
    if (item.kind === 'fence' || item.kind === 'doc-string') return [item.opening, ...item.lines, ...(item.closing === null ? [] : [item.closing])];
    return item.lines;
  }
  return [...document.preamble.flatMap(render), ...render(document.root), ...document.trailing.flatMap(render)].join(document.newline);
}

/** Validate JSON shape before rendering, then validate grammar and canonicalize it. */
export function validateDocument(input: unknown, filename: string): JsonDocument {
  function invalid(): never { throw new DocumentParserError('Ungültige JSON-Dokumentstruktur.'); }
  function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
  function string(value: unknown) { if (typeof value !== 'string') invalid(); }
  function strings(value: unknown) { if (!Array.isArray(value)) invalid(); value.forEach(string); }
  function line(value: unknown) { string(value); if (/[\n]/.test(value as string)) invalid(); }
  function layout(value: unknown) { const fields = object(value); ['indent', 'separator', 'suffix'].forEach(key => line(fields[key])); }
  let count = 0;
  function content(value: unknown, depth: number, blockOnly = false) {
    if (++count > 50000 || depth > 32) invalid();
    const item = object(value); string(item.kind);
    if (nodeKinds.has(item.kind as string) && !blockOnly) {
      const kind = documentKind(filename);
      if ((item.kind as string).startsWith('adr') !== (kind === 'adr')) invalid();
      line(item.name); line(item.keyword); layout(item.layout); list(item.before, depth + 1, true); list(item.content, depth + 1); return;
    }
    switch (item.kind) {
      case 'text': case 'blank': case 'comment': strings(item.lines); break;
      case 'metadata': string(item.key); string(item.value); layout(item.layout); break;
      case 'tags': strings(item.values); strings(item.separators); string(item.indent); string(item.suffix); break;
      case 'table':
        if (!Array.isArray(item.rows)) invalid();
        for (const value of item.rows) {
          const row = object(value); string(row.indent); string(row.suffix);
          if (!Array.isArray(row.cells)) invalid();
          for (const value of row.cells) { const cell = object(value); string(cell.value); string(cell.leading); string(cell.trailing); if (cell.spelling !== undefined) string(cell.spelling); }
        }
        break;
      case 'fence': case 'doc-string': string(item.opening); strings(item.lines); if (item.closing !== null) string(item.closing); break;
      default: invalid();
    }
  }
  function list(value: unknown, depth: number, blockOnly = false) { if (!Array.isArray(value)) invalid(); value.forEach(item => content(item, depth, blockOnly)); }
  const document = object(input);
  if (document.schemaVersion !== 1 || document.kind !== documentKind(filename) || (document.newline !== '\n' && document.newline !== '\r\n')) invalid();
  list(document.preamble, 0, true); content(document.root, 0); list(document.trailing, 0, true);
  if (object(document.root).kind !== (document.kind === 'adr' ? 'adr' : 'feature')) invalid();
  const canonical = documentFromSource(renderDocument(input as JsonDocument), filename);
  const structure = (node: JsonNode): unknown => [node.kind, node.content.filter(isJsonNode).map(structure)];
  if (JSON.stringify(structure(canonical.root)) !== JSON.stringify(structure((input as JsonDocument).root))) invalid();
  return canonical;
}
