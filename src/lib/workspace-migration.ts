import { documentFromSource, validateDocument, type JsonDocument } from './json-document';
import type { Workspace, StoredFile, StoredChange, DocumentHistory, ChangeMeta } from './types';

type LegacyFile = Omit<StoredFile, 'document'> & { source: string };
type LegacyChange = Omit<StoredChange, 'before' | 'after'> & { before: string; after: string };
type LegacyWorkspace = { files: LegacyFile[]; changes: LegacyChange[]; activeFileId: string; revision: number; history?: Record<string, { undo: string[]; redo: string[] }> };
const filenamePattern = /^[\p{L}\p{N}_. -]+\.(?:feature|md|markdown)$/iu;
const changeKinds = new Set(['ai', 'manual', 'import', 'undo', 'redo', 'review']);
const invalid = (): never => { throw new Error('Ungültiger Workspace. Die gespeicherte Datei bleibt erhalten.'); };
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  return input as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid();
  return value as string;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
  return value as number;
}
function fileFields(input: unknown): Omit<StoredFile, 'document'> {
  const file = record(input), filename = text(file.filename, 120);
  if (!filenamePattern.test(filename) || typeof file.reviewed !== 'boolean') invalid();
  return { id: text(file.id, 80), filename, version: positive(file.version), reviewed: file.reviewed as boolean };
}
function changeFields(input: unknown): ChangeMeta {
  const change = record(input), filename = text(change.filename, 120), kind = text(change.kind, 20);
  const time = text(change.time, 80);
  if (!filenamePattern.test(filename) || !changeKinds.has(kind) || !Number.isFinite(Date.parse(time))) invalid();
  return { id: text(change.id, 80), fileId: text(change.fileId, 80), filename, actor: text(change.actor, 40), instruction: text(change.instruction, 4000), kind: kind as ChangeMeta['kind'], version: positive(change.version), time };
}

/** Validate every persisted branch, including history, before a write can replace disk. */
export function migrateWorkspace(input: unknown): { workspace: Workspace; migrated: boolean } {
  const raw = record(input), version = raw.schemaVersion;
  if (version !== undefined && version !== 1 && version !== 2) throw new Error('Unbekannte Workspace-Version.');
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > 200 || !Array.isArray(raw.changes) || raw.changes.length > 100) invalid();
  const migrated = version !== 2;
  const files = (raw.files as unknown[]).map(input => {
    const fields = fileFields(input), file = record(input);
    return { ...fields, document: migrated ? documentFromSource(text(file.source, 200000), fields.filename) : validateDocument(file.document, fields.filename) };
  });
  if (new Set(files.map(file => file.id)).size !== files.length || new Set(files.map(file => file.filename)).size !== files.length) invalid();
  const activeFileId = text(raw.activeFileId, 80);
  if (!files.some(file => file.id === activeFileId)) invalid();
  const convert = (input: unknown, filename: string): JsonDocument => migrated ? documentFromSource(text(input, 200000), filename) : validateDocument(input, filename);
  const changes = (raw.changes as unknown[]).map(input => {
    const fields = changeFields(input), change = record(input);
    const file = files.find(file => file.id === fields.fileId);
    if (!file || file.filename !== fields.filename) invalid();
    return { ...fields, before: change.before === null || (migrated && change.before === '') ? null : convert(change.before, fields.filename), after: convert(change.after, fields.filename) };
  });
  const history: Record<string, DocumentHistory> | undefined = raw.history === undefined ? undefined : {};
  if (history) {
    for (const [id, input] of Object.entries(record(raw.history))) {
      const file = files.find(file => file.id === id), entry = record(input);
      if (!file || !Array.isArray(entry.undo) || !Array.isArray(entry.redo) || entry.undo.length > 50 || entry.redo.length > 50) invalid();
      Object.defineProperty(history, id, { enumerable: true, writable: true, configurable: true, value: { undo: (entry.undo as unknown[]).map(value => convert(value, file!.filename)), redo: (entry.redo as unknown[]).map(value => convert(value, file!.filename)) } });
    }
  }
  return { migrated, workspace: { schemaVersion: 2, files, changes, history, activeFileId, revision: positive(raw.revision) } };
}

// These shapes remain useful for callers preparing a v1 migration fixture.
export type { LegacyWorkspace, LegacyFile, LegacyChange };
