import type { Snapshot, SpecFile } from './types';

export type BackendListener = { snapshot: (snapshot: Snapshot) => void; connection: (connected: boolean) => void; error: (message: string) => void };
export type ReviewSession = { iid: number; title: string; source_branch: string; target_branch: string; web_url: string; state: string };
export interface StudioBackend {
  readonly collaboration: boolean;
  readonly label: string;
  readonly readOnly?: boolean;
  repository?: {
    submit(title: string): Promise<Snapshot>;
    discard(): Promise<Snapshot>;
    resolveConflict(): Promise<Snapshot>;
    sessions(): Promise<ReviewSession[]>;
    join(iid: number): Promise<Snapshot>;
    leave(): Promise<Snapshot>;
  };
  load(): Promise<Snapshot>;
  request(body: Record<string, unknown>): Promise<Snapshot>;
  subscribe(listener: BackendListener): () => void;
  agent(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
  download(file: SpecFile, format: 'source' | 'json'): void;
}
export function downloadDocument(file: SpecFile, format: 'source' | 'json') {
  const content = format === 'json' ? JSON.stringify({ schemaVersion: 1, filename: file.filename, document: file.document }, null, 2) + '\n' : file.source;
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = file.filename + (format === 'json' ? '.json' : ''); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const prefix = process.env.NEXT_PUBLIC_BASE_PATH || '';
export const serverBackend: StudioBackend = {
  collaboration: true, label: 'Live verbunden',
  async load() { const response = await fetch(`${prefix}/api/workspace`); if (!response.ok) throw new Error('Die Dokumente konnten nicht geladen werden.'); return response.json(); },
  async request(body) {
    const response = await fetch(`${prefix}/api/workspace`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  },
  subscribe(listener) {
    const stream = new EventSource(`${prefix}/api/events`);
    stream.onopen = () => listener.connection(true);
    stream.onmessage = event => { listener.snapshot(JSON.parse(event.data)); listener.connection(true); };
    stream.onerror = () => listener.connection(false);
    return () => stream.close();
  },
  agent(body, signal) { return fetch(`${prefix}/api/agent`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  download: downloadDocument,
};
