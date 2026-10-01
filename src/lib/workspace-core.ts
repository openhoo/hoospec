import { ApiError } from './errors';
import { documentFromSource, renderDocument, validateDocument, type JsonDocument } from './json-document';
import type { Change, Workspace, StoredFile } from './types';

export function fileAt<T extends StoredFile>(workspace: { files: T[] }, id: string, version?: number) {
  const file = workspace.files.find(f => f.id === id);
  if (!file) throw new ApiError('Dokument nicht gefunden.', 404);
  if (version !== undefined && file.version !== version) throw new ApiError('Das Dokument wurde inzwischen geändert. Bitte die aktuelle Version prüfen und erneut versuchen.', 409);
  return file;
}

export function historyFor(workspace: Workspace, id: string) {
  const histories = workspace.history ??= {};
  if (!Object.hasOwn(histories, id)) {
    let cursor = renderDocument(fileAt(workspace, id).document);
    const undo: JsonDocument[] = [];
    for (const change of workspace.changes) {
      if (change.fileId === id && ['ai', 'manual'].includes(change.kind) && renderDocument(change.after) === cursor && change.before) {
        undo.unshift(change.before); cursor = renderDocument(change.before);
      }
    }
    Object.defineProperty(histories, id, { enumerable: true, writable: true, configurable: true, value: { undo: undo.slice(-50), redo: [] } });
  }
  return histories[id];
}

export function restoreHistory(workspace: Workspace, id: string, version: number, actor: string, action: 'undo' | 'redo') {
  const file = fileAt(workspace, id, version);
  const history = historyFor(workspace, id);
  const from = history[action], to = history[action === 'undo' ? 'redo' : 'undo'];
  const document = from.at(-1);
  if (document === undefined) throw new ApiError(action === 'undo' ? 'Keine weitere Änderung zum Rückgängigmachen.' : 'Keine Änderung zum Wiederherstellen.', 409);
  const previous = file.document;
  applyDocumentChange(workspace, id, version, document, actor, action === 'undo' ? 'Änderung rückgängig gemacht' : 'Änderung wiederhergestellt', action);
  from.pop(); to.push(previous);
  if (to.length > 50) to.shift();
}

export function applyChange(workspace: Workspace, id: string, version: number, source: string, actor: string, instruction: string, kind: Change['kind']) {
  const file = fileAt(workspace, id, version);
  return applyDocumentChange(workspace, id, version, documentFromSource(source, file.filename), actor, instruction, kind);
}

export function applyDocumentChange(workspace: Workspace, id: string, version: number, input: unknown, actor: string, instruction: string, kind: Change['kind']) {
  const file = fileAt(workspace, id, version);
  const document = validateDocument(input, file.filename);
  if (renderDocument(document) === renderDocument(file.document)) throw new ApiError('Die Änderung hat keinen Unterschied erzeugt.');
  const before = file.document;
  if (kind === 'manual' || kind === 'ai') {
    const history = historyFor(workspace, id);
    history.undo.push(before); history.undo = history.undo.slice(-50); history.redo = [];
  }
  file.document = document;
  file.version++;
  file.reviewed = false;
  workspace.changes.unshift({ id: crypto.randomUUID(), fileId: id, filename: file.filename, actor, instruction, kind, before, after: document, version: file.version, time: new Date().toISOString() });
  workspace.changes = workspace.changes.slice(0, 100);
  return file;
}
