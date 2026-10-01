import { parseSpec } from './gherkin';
import { parseAdr } from './adr';

export function documentKind(filename: string): 'feature' | 'adr' {
  return /\.(md|markdown)$/i.test(filename) ? 'adr' : 'feature';
}
export function parseDocument(source: string, filename: string) {
  return documentKind(filename) === 'adr' ? parseAdr(source) : parseSpec(source);
}
