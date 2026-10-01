import type { SpecNode } from './gherkin';
import { markdownCodeLines, markdownHeading } from './markdown';

export class AdrParserError extends Error { name = 'AdrParserError'; }

export type AdrStatus = 'open' | 'accepted' | 'rejected' | 'superseded';
export const adrStatuses: Record<AdrStatus, string> = { open: 'Offen', accepted: 'Angenommen', rejected: 'Verworfen', superseded: 'Ersetzt' };
const aliases: Record<string, AdrStatus> = {
  offen: 'open', proposed: 'open', draft: 'open', entwurf: 'open', vorgeschlagen: 'open', pending: 'open',
  accepted: 'accepted', angenommen: 'accepted', beschlossen: 'accepted',
  rejected: 'rejected', verworfen: 'rejected', abgelehnt: 'rejected',
  superseded: 'superseded', deprecated: 'superseded', ersetzt: 'superseded', veraltet: 'superseded',
};

function headings(source: string) {
  const lines = source.split('\n'), code = markdownCodeLines(lines);
  return lines.flatMap((line, index) => {
    if (code.has(index)) return [];
    const heading = markdownHeading(line);
    return heading ? [{ ...heading, line: index + 1 }] : [];
  });
}

export function parseAdr(source: string): SpecNode {
  const lines = source.split('\n'), entries = headings(source);
  const title = entries.find(entry => entry.level === 1);
  if (!title || entries.filter(entry => entry.level === 1).length !== 1) throw new AdrParserError('Eine ADR braucht genau einen Titel als Markdown-Überschrift (# Titel).');
  readAdrStatus(source);
  function build(entry: typeof title & {}, boundary: number): SpecNode {
    let end = boundary;
    while (end > entry.line && !lines[end - 1]?.trim()) end--;
    const children = entries.filter(item => item.line > entry.line && item.line <= end);
    const direct: typeof entries = [];
    let parentEnd = entry.line;
    for (const child of children) {
      if (child.line <= parentEnd) continue;
      direct.push(child);
      const next = entries.find(item => item.line > child.line && item.level <= child.level);
      parentEnd = Math.min(end, next ? next.line - 1 : end);
    }
    const bodyEnd = direct[0] ? direct[0].line - 1 : end;
    const questions = entry.level > 1 && isQuestionSection(entry.name) ? questionsIn(lines, entry.line, bodyEnd) : [];
    return { id: `${entry.level === 1 ? 'adr' : 'adr-section'}:${entry.line}`, kind: entry.level === 1 ? 'adr' : 'adr-section',
      keyword: entry.keyword, name: entry.name, description: lines.slice(entry.line, questions[0] ? questions[0].start - 1 : bodyEnd).join('\n').replace(/^\n+|\n+$/g, ''),
      start: entry.line, end, tags: [], children: [...questions, ...direct.map((child, index) => build(child, index + 1 < direct.length ? direct[index + 1].line - 1 : end))] };
  }
  return build(title, lines.length);
}

function statusLocation(source: string) {
  const lines = source.split('\n'), code = markdownCodeLines(lines);
  const entries = headings(source);
  const title = entries.find(entry => entry.level === 1);
  const firstSection = entries.find(entry => entry.level > 1);
  // Metadata in the introduction, or the conventional "## Status" section.
  for (let index = (title?.line || 1); index < (firstSection ? firstSection.line - 1 : lines.length); index++) {
    if (code.has(index)) continue;
    const clean = lines[index].replace(/\*/g, '').trim();
    const match = clean.match(/^Status\s*:\s*(.+)$/i);
    if (match) return { line: index, value: match[1], inline: true };
  }
  const section = entries.find(entry => entry.name.toLowerCase() === 'status');
  if (section) {
    const end = entries.find(entry => entry.line > section.line && entry.level <= section.level)?.line || lines.length + 1;
    for (let index = section.line; index < end - 1; index++) {
      if (!code.has(index) && lines[index].trim()) return { line: index, value: lines[index].replace(/\*/g, '').trim(), inline: false };
    }
    return { line: section.line, value: '', inline: false };
  }
  return null;
}
export function readAdrStatus(source: string): AdrStatus {
  const location = statusLocation(source);
  if (!location || !location.value) return 'open';
  const status = aliases[location.value.toLowerCase()];
  if (!status) throw new AdrParserError('ADR-Status muss Offen, Angenommen, Verworfen oder Ersetzt sein.');
  return status;
}
export function setAdrStatus(source: string, status: AdrStatus) {
  if (!Object.hasOwn(adrStatuses, status)) throw new AdrParserError('Ungültiger ADR-Status.');
  const root = parseAdr(source), lines = source.split('\n'), location = statusLocation(source);
  if (location) {
    if (location.value) {
      const line = lines[location.line];
      const at = line.lastIndexOf(location.value);
      if (at < 0) throw new AdrParserError('Die Statusformatierung kann nicht sicher bearbeitet werden.');
      lines[location.line] = line.slice(0, at) + adrStatuses[status] + line.slice(at + location.value.length);
    }
    else lines.splice(location.line, 0, adrStatuses[status]);
  } else lines.splice(root.start, 0, '', `Status: ${adrStatuses[status]}`);
  const result = lines.join('\n'); parseAdr(result); return result;
}
export function adrIntroduction(source: string) {
  return parseAdr(source).description.split('\n').filter(line => !/^\s*(Status|Datum|Date)\s*:/i.test(line.replace(/\*/g, ''))).join('\n').trim();
}
export function createAdr(title: string, context = '') {
  if (!title.trim() || /[\r\n]/.test(title)) throw new AdrParserError('Bitte einen Titel in einer Zeile eingeben.');
  return `# ${title.trim()}\n\nStatus: Offen\n\n## Kontext\n\n${context.trim() || 'Welches Problem wollen wir lösen?'}\n\n## Offene Fragen\n\n- Was müssen wir vor der Entscheidung klären?\n\n## Optionen\n\n- Welche Alternativen kommen infrage?\n\n## Entscheidung\n\nNoch offen.\n\n## Konsequenzen\n\nWelche Folgen hätte die Entscheidung?\n`;
}
export function nextAdrFilename(filenames: string[]) {
  const numbers = filenames.map(name => Number(name.match(/^(?:adr[-_])?(\d+)/i)?.[1] || 0));
  return `adr-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}.md`;
}

export function isQuestionSection(name: string) {
  return /^(offene fragen|fragen|open questions|questions|unresolved questions)$/i.test(name.trim());
}

/** Markdown keeps each answer inside its list item, so import/export need no sidecar data. */
export function questionParts(source: string, node: SpecNode) {
  const lines = source.split('\n').slice(node.start - 1, node.end);
  const first = lines[0]?.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/);
  if (!first) throw new AdrParserError('Diese Frage ist nicht mehr vorhanden.');
  const code = markdownCodeLines(lines);
  const answerAt = lines.findIndex((line, index) => index > 0 && !code.has(index) && /^\s+(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:(?:\*\*)?\s*/i.test(line));
  const questionEnd = answerAt < 0 ? lines.length : answerAt;
  const question = [first[2], ...lines.slice(1, questionEnd).map(line => line.trim())].join('\n').trim();
  const answer = answerAt < 0 ? '' : [lines[answerAt].replace(/^\s+(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:(?:\*\*)?\s*/i, ''), ...lines.slice(answerAt + 1).map(line => line.replace(/^ {2}/, ''))].join('\n').trim();
  return { lines, prefix: first[1], question, answer, answerAt, questionEnd };
}

function questionsIn(lines: string[], start: number, end: number): SpecNode[] {
  const items: { line: number; indent: number; keyword: string; text: string }[] = [];
  const code = markdownCodeLines(lines);
  for (let index = start; index < end; index++) {
    if (code.has(index)) continue;
    const bullet = lines[index].match(/^( *)([-*+]|\d+[.)])\s+(.+)$/);
    if (bullet) items.push({ line: index + 1, indent: bullet[1].length, keyword: bullet[2], text: bullet[3] });
  }
  if (!items.length) return [];
  const indent = Math.min(...items.map(item => item.indent));
  const top = items.filter(item => item.indent === indent);
  return top.map((item, index) => {
    let boundary = index + 1 < top.length ? top[index + 1].line - 1 : end;
    // A blank line followed by unindented prose starts content outside this list item.
    let blank = false;
    for (let line = item.line; line < boundary; line++) {
      if (!lines[line].trim()) { blank = true; continue; }
      const leading = lines[line].match(/^ */)![0].length;
      if (blank && leading <= item.indent) { boundary = line; break; }
      blank = false;
    }
    while (boundary > item.line && !lines[boundary - 1]?.trim()) boundary--;
    const node: SpecNode = { id: `adr-question:${item.line}`, kind: 'adr-question', keyword: item.keyword, name: item.text, description: '', start: item.line, end: boundary, tags: [], children: [] };
    const parts = questionParts(lines.join('\n'), node);
    node.name = parts.question; node.description = parts.answer;
    if (parts.answerAt >= 0) {
      const answerStart = item.line + parts.answerAt;
      node.children.push({ id: `adr-answer:${answerStart}`, kind: 'adr-answer', keyword: 'Antwort', name: 'Antwort', description: parts.answer, start: answerStart, end: boundary, tags: [], children: [] });
    }
    return node;
  });
}

export function recordAdrDecision(source: string, decision: string) {
  if (!decision.trim()) throw new AdrParserError('Bitte eure Entscheidung aufschreiben.');
  const root = parseAdr(source);
  const section = root.children.find(node => /^(entscheidung|decision)$/i.test(node.name));
  const lines = source.split('\n');
  if (section) lines.splice(section.start, section.end - section.start, '', ...decision.trim().split('\n'));
  else lines.push('', '## Entscheidung', '', ...decision.trim().split('\n'), '');
  return setAdrStatus(lines.join('\n'), 'accepted');
}
