/** Accept one unambiguous code block; explanations never enter the saved spec. */
export function normalizeAgentSource(output: string, format: 'gherkin' | 'markdown' = 'gherkin'): string {
  const normalized = output.replace(/\r\n/g, '\n');
  if (format === 'markdown' && /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:)/.test(normalized.trimStart())) return normalized.replace(/^\n+|\n+$/g, '');
  const fences = [...normalized.matchAll(/^\s*```([^\n`]*)\n?/gm)];
  if (!fences.length) return normalized.replace(/^\n+/, '').replace(/\n+$/, '');
  if (fences.length !== 2 || fences[1][1].trim()) throw new Error('Der Agent muss genau einen vollständigen Änderungsblock zurückgeben.');
  if (!/^(gherkin|feature|markdown|md|text|plaintext)?$/i.test(fences[0][1].trim())) throw new Error('Der Agent hat keinen gültigen Änderungsblock zurückgegeben.');
  return normalized.slice(fences[0].index! + fences[0][0].length, fences[1].index).replace(/\n+$/, '');
}

/** A transient, never-persisted view of the code that has arrived so far. */
export function previewAgentSource(output: string, format: 'gherkin' | 'markdown' = 'gherkin'): string {
  const normalized = output.replace(/\r\n/g, '\n');
  if (format === 'markdown' && /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:)/.test(normalized.trimStart())) return normalized.replace(/^\n+|\n+$/g, '');
  const opening = normalized.match(/```(?:gherkin|feature|markdown|md|text|plaintext)?[^\S\n]*\n/i);
  if (opening?.index !== undefined) return normalized.slice(opening.index + opening[0].length).split('```')[0].replace(/\n+$/, '');
  if (normalized.includes('```')) return '';
  return normalized;
}

/** Keep the selected range's base indentation, retaining nested relative offsets. */
export function alignAgentIndent(source: string, replacement: string): string {
  const originalIndent = source.match(/^ */)?.[0].length || 0;
  const generatedIndent = replacement.match(/^ */)?.[0].length || 0;
  return replacement.split('\n').map(line => line.trim() ? ' '.repeat(originalIndent) + line.slice(Math.min(generatedIndent, line.match(/^ */)![0].length)) : line).join('\n');
}
