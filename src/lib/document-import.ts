import { documentFromSource, validateDocument, DocumentParserError } from './json-document';

export function importDocument(filename: string, source: string) {
  if (!/\.json$/i.test(filename)) return { filename, document: documentFromSource(source, filename) };
  let input;
  try { input = JSON.parse(source); } catch { throw new DocumentParserError('Die JSON-Datei ist ungültig.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 || typeof input.filename !== 'string') throw new DocumentParserError('Ein JSON-Import braucht schemaVersion, filename und document aus dem Hoospec-Export.');
  return { filename: input.filename as string, document: validateDocument(input.document, input.filename) };
}
