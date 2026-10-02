import { agentConnection } from './agent-connection';
import { mkdir, readFile, rename, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors';
import { seedWorkspace } from './seed';
import { renderDocument } from './json-document';
import { migrateWorkspace } from './workspace-migration';
import type { LiveDraft, Participant, Snapshot, Workspace } from './types';

const dir = path.resolve(/* turbopackIgnore: true */ process.env.HOOSPEC_DATA_DIR || '.hoospec');
const statePath = path.join(dir, 'workspace.json');
const globalStore = globalThis as typeof globalThis & { hoospec?: { queue: Promise<unknown>; people: Map<string, Participant>; listeners?: Set<() => void>; drafts?: Map<string, LiveDraft> } };
const state = globalStore.hoospec ??= { queue: Promise.resolve(), people: new Map(), listeners: new Set<() => void>(), drafts: new Map<string, LiveDraft>() };
const listeners = state.listeners ??= new Set();
const drafts = state.drafts ??= new Map();
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
function publish() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => { broadcastTimer = undefined; for (const listener of listeners) listener(); }, 45);
}
export function subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); }
export function updateDraft(draft: LiveDraft) { drafts.set(draft.fileId, draft); publish(); }
export function clearDraft(fileId: string) { drafts.delete(fileId); publish(); }

export { ApiError } from './errors';
let cached: { stamp: string; workspace: Workspace } | undefined;
async function diskStamp() { const info = await stat(statePath, { bigint: true }); return `${info.mtimeNs}:${info.size}`; }

async function read(): Promise<Workspace> {
  try {
    const stamp = await diskStamp();
    if (cached?.stamp === stamp) return structuredClone(cached.workspace);
    const original = await readFile(statePath, 'utf8');
    const { workspace, migrated } = migrateWorkspace(JSON.parse(original));
    if (migrated) {
      // Never replace the previous backup; it contains the original source and histories.
      try { await writeFile(path.join(dir, 'workspace.v1.backup.json'), original, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await persist(workspace);
    }
    cached = { stamp: migrated ? await diskStamp() : stamp, workspace: structuredClone(workspace) };
    return workspace;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return structuredClone(seedWorkspace);
  }
}

async function persist(workspace: Workspace) {
  await mkdir(dir, { recursive: true });
  const temp = path.join(dir, `${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(workspace, null, 2), { mode: 0o600 });
    await rename(temp, statePath);
    cached = { stamp: await diskStamp(), workspace: structuredClone(workspace) };
  } finally { await rm(temp, { force: true }); }
}

export function transact<T>(fn: (workspace: Workspace) => T | Promise<T>): Promise<T> {
  const result = state.queue.then(async () => {
    const workspace = await read();
    const result = await fn(workspace);
    workspace.revision++;
    await persist(workspace);
    publish();
    return result;
  });
  state.queue = result.catch(() => {});
  return result;
}

export async function snapshot(): Promise<Snapshot> {
  const ai = await agentConnection();
  // Reads and initial migration share the same queue as writes.
  const result = state.queue.then(async () => {
    const workspace = await read();
    for (const [id, person] of state.people) if (Date.now() - person.seen > 35000) state.people.delete(id);
    return { ...workspace, history: workspace.history ? Object.fromEntries(Object.entries(workspace.history).map(([id, entry]) => [id, { undo: entry.undo.length, redo: entry.redo.length }])) : undefined, files: workspace.files.map(file => ({ ...file, source: renderDocument(file.document) })),
      changes: workspace.changes.map(change => ({ ...change, before: change.before ? renderDocument(change.before) : '', after: renderDocument(change.after) })),
      participants: [...state.people.values()], drafts: [...drafts.values()], ...ai };
  });
  state.queue = result.catch(() => {});
  return result;
}

export function presence(id: string, name: string) {
  if (!/^[\w-]{1,80}$/.test(id)) throw new ApiError('Ungültige Teilnehmer-ID.');
  if (!state.people.has(id) && state.people.size >= 100) throw new ApiError('Der Review-Raum ist voll.', 429);
  state.people.set(id, { id, name: name.slice(0, 40).trim() || 'Gast', seen: Date.now() });
  publish();
}

export { fileAt, historyFor, restoreHistory, applyChange, applyDocumentChange } from './workspace-core';
