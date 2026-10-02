import type { JsonDocument } from './json-document';

export type StoredFile = { id: string; filename: string; document: JsonDocument; version: number; reviewed: boolean };
/** Source is a generated view for the editor and exports, never persisted. */
export type SpecFile = StoredFile & { source: string };
export type ChangeMeta = { id: string; fileId: string; filename: string; actor: string; instruction: string; kind: 'ai' | 'manual' | 'import' | 'undo' | 'redo' | 'review'; version: number; time: string };
export type StoredChange = ChangeMeta & { before: JsonDocument | null; after: JsonDocument };
export type Change = ChangeMeta & { before: string; after: string };
export type DocumentHistory = { undo: JsonDocument[]; redo: JsonDocument[] };
export type Workspace = { schemaVersion: 2; files: StoredFile[]; changes: StoredChange[]; activeFileId: string; revision: number; history?: Record<string, DocumentHistory> };
export type Participant = { id: string; name: string; seen: number };
export type LiveDraft = { fileId: string; nodeId: string; version: number; actor: string; text: string; phase: 'reading' | 'writing' | 'validating' };
export type RepositoryReview = {
  project: string; targetBranch: string; branch: string; conflict: boolean; submissionPending: boolean;
  changes: { filename: string; path: string; before: string; after: string }[];
  mergeRequest?: { iid: number; title: string; url: string; state: string };
};
export type AIModel = { id: string; name: string };
export type Snapshot = Omit<Workspace, 'files' | 'changes' | 'history'> & { history?: Record<string, { undo: number; redo: number }>; files: SpecFile[]; changes: Change[]; participants: Participant[]; drafts: LiveDraft[]; aiReady: boolean; model: string; aiModels?: AIModel[]; aiModel?: string; repository?: RepositoryReview };
