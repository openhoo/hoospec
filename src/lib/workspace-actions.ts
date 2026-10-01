import { ApiError } from './errors';
import { applyChange, applyDocumentChange, fileAt, restoreHistory } from './workspace-core';
import { textField, versionField } from './http';
import { documentKind } from './document';
import { renderDocument, validateDocument } from './json-document';
import { importDocument } from './document-import';
import { setAdrStatus, recordAdrDecision, type AdrStatus } from './adr';
import type { Workspace } from './types';

export function applyWorkspaceAction(workspace: Workspace, body: Record<string, unknown>) {
  const action = textField(body, 'action', 30), actor = textField(body, 'actor', 40);
      if (action === 'import') {
        if (workspace.files.length >= 200) throw new ApiError('Maximal 200 Dokumente pro Workspace.');
        const imported = body.document !== undefined ? { filename: textField(body, 'filename', 120), document: validateDocument(body.document, textField(body, 'filename', 120)) } : importDocument(textField(body, 'filename', 120), textField(body, 'source', 2000000));
        const { filename, document } = imported;
        if (!/^[\p{L}\p{N}_. -]+\.(?:feature|md|markdown)$/iu.test(filename)) throw new ApiError('Bitte eine .feature- oder .md-Datei mit gültigem Dateinamen wählen.');
        if (workspace.files.some(f => f.filename === filename)) throw new ApiError('Ein Dokument mit diesem Namen existiert bereits.');

        const file = { id: crypto.randomUUID(), filename, document, version: 1, reviewed: false };
        workspace.files.push(file);
        workspace.activeFileId = file.id;
        workspace.changes.unshift({ id: crypto.randomUUID(), fileId: file.id, filename, actor, instruction: documentKind(filename) === 'adr' ? 'ADR erstellt oder importiert' : 'Spec importiert', kind: 'import', before: null, after: document, version: 1, time: new Date().toISOString() });
      } else {
        const id = textField(body, 'fileId', 80);
        if (action === 'navigate') { fileAt(workspace, id); workspace.activeFileId = id; }
        else if (action === 'save-document') applyDocumentChange(workspace, id, versionField(body), body.document, actor, 'Dokument direkt bearbeitet', 'manual');
        else if (action === 'save') applyChange(workspace, id, versionField(body), textField(body, 'source'), actor, 'Dokument direkt bearbeitet', 'manual');
        else if (action === 'adr-decision') {
          const file = fileAt(workspace, id, versionField(body));
          if (documentKind(file.filename) !== 'adr') throw new ApiError('Dieses Dokument ist keine ADR.');
          const source = recordAdrDecision(renderDocument(file.document), textField(body, 'decision', 20000));
          applyChange(workspace, id, file.version, source, actor, 'Entscheidung manuell festgehalten', 'manual');
        }
        else if (action === 'adr-status') {
          const file = fileAt(workspace, id, versionField(body));
          if (documentKind(file.filename) !== 'adr') throw new ApiError('Dieses Dokument ist keine ADR.');
          const status = textField(body, 'status', 30) as AdrStatus;
          const source = setAdrStatus(renderDocument(file.document), status);
          applyChange(workspace, id, file.version, source, actor, 'ADR-Status geändert', 'manual');
        }
        else if (action === 'review') {
          const file = fileAt(workspace, id, versionField(body));
          file.reviewed = !file.reviewed;
          file.version++;
          workspace.changes.unshift({ id: crypto.randomUUID(), fileId: id, filename: file.filename, actor, instruction: file.reviewed ? 'Review abgeschlossen' : 'Review wieder geöffnet', kind: 'review', before: file.document, after: file.document, version: file.version, time: new Date().toISOString() });
        } else if (action === 'undo' || action === 'redo') {
          restoreHistory(workspace, id, versionField(body), actor, action);
        } else throw new ApiError('Unbekannte Aktion.');
      }
      workspace.changes = workspace.changes.slice(0, 100);
}
