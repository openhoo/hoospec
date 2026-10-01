import type { GitLabAccess } from './gitlab-auth';
import { GitLabClient, decodeRepositoryFile, normalizeGitLabConfig, repositoryPath, type GitLabConfig, type RepositoryFile, type CommitAction } from './gitlab-client';
import { migrateWorkspace } from './workspace-migration';
import { applyWorkspaceAction } from './workspace-actions';
import { applyChange, fileAt } from './workspace-core';
import { readAdrStatus } from './adr';
import { textField, versionField } from './http';
import { documentFromSource, renderDocument } from './json-document';
import { flattenNodes, replaceNode } from './gherkin';
import { EventStreamDecoder } from './event-stream';
import { parseDocument, documentKind } from './document';
import { downloadDocument, type BackendListener, type StudioBackend } from './studio-backend';
import type { Snapshot, Workspace } from './types';

export type RepositoryManifest = { schemaVersion: 1; workspace: Workspace; paths: Record<string, string> };
export function parseRepositoryManifest(source: string): RepositoryManifest {
  const input = JSON.parse(source);
  if (input?.schemaVersion !== 1 || !input.workspace || !input.paths || typeof input.paths !== 'object' || Array.isArray(input.paths)) throw new Error('Ungültiger Hoospec-Repository-Workspace.');
  const { workspace } = migrateWorkspace(input.workspace);
  const paths: Record<string, string> = {};
  for (const file of workspace.files) {
    const path = input.paths[file.id];
    if (typeof path !== 'string' || documentKind(path) !== documentKind(file.filename) || !/\.(feature|md|markdown)$/i.test(path)) throw new Error('Ungültige Dokumentpfade im Repository-Workspace.');
    Object.defineProperty(paths, file.id, { value: repositoryPath(path), enumerable: true, configurable: true, writable: true });
  }
  if (new Set(Object.values(paths)).size !== workspace.files.length) throw new Error('Dokumente dürfen nicht auf dieselbe Repository-Datei zeigen.');
  return { schemaVersion: 1, workspace, paths };
}
export function repositoryFilename(repositoryFilePath: string, id: string, used: Set<string>) {
  const basename = repositoryFilePath.split('/').at(-1)!;
  if (basename.length <= 120 && /^[\p{L}\p{N}_. -]+\.(feature|md|markdown)$/iu.test(basename) && !used.has(basename)) return basename;
  const extension = basename.match(/\.(feature|md|markdown)$/i)?.[0];
  if (!extension) throw new Error('Unbekanntes Repository-Dokumentformat.');
  const stem = basename.slice(0, -extension.length).replace(/[^\p{L}\p{N}_. -]/gu, '_').trim() || 'document';
  for (let count = 0; ; count++) {
    const suffix = id.slice(-16) + (count ? '_' + count : '');
    const name = `${stem.slice(0, 119 - extension.length - suffix.length)}-${suffix}${extension}`;
    if (!used.has(name)) return name;
  }
}
function snapshotOf(workspace: Workspace, revision: number): Snapshot {
  return { ...structuredClone(workspace), revision, files: workspace.files.map(file => ({ ...file, source: renderDocument(file.document) })),
    changes: workspace.changes.map(change => ({ ...change, before: change.before ? renderDocument(change.before) : '', after: renderDocument(change.after) })),
    history: workspace.history ? Object.fromEntries(Object.entries(workspace.history).map(([id, entry]) => [id, { undo: entry.undo.length, redo: entry.redo.length }])) : {},
    participants: [], drafts: [], aiReady: false, model: '' };
}
export class GitLabBackend implements StudioBackend {
  readonly collaboration = false;
  readonly sessionId = crypto.randomUUID();
  get readOnly() { return this.client.readOnly; }
  get label() { return this.readOnly ? 'Mit GitLab verbunden · Nur lesen' : 'Mit GitLab verbunden'; }
  readonly client: GitLabClient;
  private manifest?: RepositoryManifest;
  private canonical: RepositoryFile | null = null;
  private head = '';
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<BackendListener>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private agentRequests = new Set<AbortController>();
  constructor(config: GitLabConfig, token: string | GitLabAccess, fetcher?: typeof fetch, private agentToken = '', private readonly bridgeFetch: typeof fetch = fetch) { this.client = new GitLabClient(config, token, fetcher); }
  private get path() { return `${this.client.config.directory}/workspace.json`; }
  private serialized<T>(work: () => Promise<T>) { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  private emit() { const state = this.current(); for (const listener of this.listeners) { listener.snapshot(state); listener.connection(true); } return state; }
  private current() { if (!this.manifest) throw new Error('Repository noch nicht geladen.'); return { ...snapshotOf(this.manifest.workspace, this.revision), aiReady: !!this.client.config.agentUrl && !!this.agentToken, model: this.client.config.agentUrl ? 'Serverseitiger Agent' : '' }; }
  private async refresh() {
    if (this.stopped) throw new Error('Repository-Verbindung wurde getrennt.');
    const previousReadOnly = this.readOnly;
    await this.client.verifyMembership();
    const head = await this.client.head();
    if (previousReadOnly !== this.readOnly) this.revision++;
    if (head === this.head && this.manifest) return;
    const canonical = await this.client.file(this.path, head);
    let manifest: RepositoryManifest;
    if (canonical) manifest = parseRepositoryManifest(decodeRepositoryFile(canonical));
    else {
      const paths = (await this.client.tree(head)).filter(path => /\.feature$/i.test(path) || (/\.(md|markdown)$/i.test(path) && !!this.client.config.adrDirectory && path.startsWith(this.client.config.adrDirectory + '/')));
      if (paths.length > 200) throw new Error('Maximal 200 Specs und ADRs pro Workspace.');
      const files: Workspace['files'] = [], mapping: Record<string, string> = {};
      for (const path of paths) {
        const remote = await this.client.file(path, head);
        if (!remote) throw new Error('Eine Repository-Datei wurde während des Ladens entfernt.');
        const source = decodeRepositoryFile(remote);
        const id = `gitlab-${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path)))).map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 32)}`;
        if (source.length > 200000) throw new Error('Eine Spec oder ADR ist zu groß (maximal 200.000 Zeichen). Bitte das Dokument aufteilen.');
        const filename = repositoryFilename(path, id, new Set(files.map(file => file.filename)));
        files.push({ id, filename, document: documentFromSource(source, filename), version: 1, reviewed: false }); mapping[id] = path;
      }
      manifest = { schemaVersion: 1, workspace: { schemaVersion: 2, revision: 1, files, changes: [], activeFileId: files[0]?.id || '', history: {} }, paths: mapping };
    }
    if (this.stopped) throw new Error('Repository-Verbindung wurde getrennt.');
    this.canonical = canonical; this.manifest = manifest; this.head = head; this.revision++;
  }
  load(): Promise<Snapshot> { return this.serialized(async () => { await this.refresh(); return this.emit(); }); }
  subscribe(listener: BackendListener) {
    this.listeners.add(listener);
    if (this.manifest) { listener.snapshot(this.current()); listener.connection(true); }
    if (!this.timer) this.timer = setInterval(() => {
      void this.load().catch(error => { for (const item of this.listeners) { item.connection(false); item.error((error as Error).message); } });
    }, 10000);
    return () => { this.listeners.delete(listener); if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = undefined; } };
  }
  configureAgent(url: string, token: string) {
    this.client.config.agentUrl = normalizeGitLabConfig({ ...this.client.config, agentUrl: url }).agentUrl;
    this.agentToken = token.trim(); this.revision++; this.emit();
  }
  disconnect() { this.agentToken = ''; this.stopped = true; for (const abort of this.agentRequests) abort.abort(); this.agentRequests.clear(); this.client.disconnect(); if (this.timer) clearInterval(this.timer); this.listeners.clear(); }
  request(body: Record<string, unknown>): Promise<Snapshot> {
    return this.serialized(async () => {
      if (body.action === 'presence') return this.current();
      const beforeRefresh = this.manifest?.workspace.files.find(file => file.id === body.fileId);
      await this.refresh();
      const current = this.manifest!;
      if (body.action === 'navigate') {
        if (!current.workspace.files.some(file => file.id === body.fileId)) throw new Error('Dokument nicht gefunden.');
        current.workspace.activeFileId = body.fileId as string; this.revision++; return this.emit();
      }
      const fresh = current.workspace.files.find(file => file.id === body.fileId);
      if (beforeRefresh && fresh && renderDocument(beforeRefresh.document) !== renderDocument(fresh.document)) throw new Error('Das Dokument wurde inzwischen in GitLab geändert. Dein Entwurf bleibt erhalten. Bitte den aktuellen Stand prüfen.');
      if (this.readOnly) throw new Error('Du hast auf diesem Branch nur Leserechte. Ein Projekt-Maintainer kann Schreibrechte freigeben.');
      const next = structuredClone(current);
      applyWorkspaceAction(next.workspace, body); next.workspace.revision++;
      await this.persist(current, next, body.action === 'review' ? 'Hoospec: Review aktualisiert' : `Hoospec: ${String(body.action === 'import' ? 'Dokument importiert' : 'Dokument bearbeitet')}`);
      return this.emit();
    });
  }
  private async persist(previous: RepositoryManifest, next: RepositoryManifest, message: string, signal?: AbortSignal) {
    for (const file of next.workspace.files) next.paths[file.id] ||= `${this.client.config.directory}/${documentKind(file.filename) === 'adr' ? 'adrs' : 'specs'}/${file.filename}`;
    const manifestSource = JSON.stringify(next, null, 2) + '\n';
    if (new TextEncoder().encode(manifestSource).byteLength > 16000000) throw new Error('Der JSON-Workspace mit Verlauf ist zu groß (maximal 16 MB). Bitte einen kleineren Dokumentbestand in einem separaten Hoospec-Verzeichnis verwalten. Es wurde nichts gespeichert.');
    const actions: CommitAction[] = [];
    for (const file of next.workspace.files) {
      const old = previous.workspace.files.find(item => item.id === file.id);
      const content = renderDocument(file.document);
      const path = next.paths[file.id];
      if (old && renderDocument(old.document) === content && this.canonical) continue;
      const remote = await this.client.file(path, this.head);
      if (remote && (!old || decodeRepositoryFile(remote) !== renderDocument(old.document))) throw new Error(`Die Datei ${path} wurde außerhalb von Hoospec geändert. Sie wird nicht überschrieben.`);
      if (!remote || decodeRepositoryFile(remote) !== content) actions.push({ action: remote ? 'update' : 'create', file_path: path, content, ...(remote ? { last_commit_id: remote.last_commit_id } : {}) });
    }
    actions.push({ action: this.canonical ? 'update' : 'create', file_path: this.path, content: manifestSource, ...(this.canonical ? { last_commit_id: this.canonical.last_commit_id } : {}) });
    signal?.throwIfAborted();
    if (this.stopped) throw new Error('Repository-Verbindung wurde getrennt.');
    await this.client.commit(actions, message);
    // Read the committed branch before accepting anything as saved.
    this.head = ''; await this.refresh(); this.revision++;
  }
  async agent(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    await this.load();
    if (this.readOnly) return Response.json({ error: 'Du hast auf diesem Branch nur Leserechte.' }, { status: 403 });
    const endpoint = this.client.config.agentUrl;
    if (!endpoint || !this.agentToken) return Response.json({ error: 'Bitte unter Repository-Verbindung den serverseitigen Agent-Dienst und seinen Zugang einrichten.' }, { status: 503 });
    const fileId = textField(body, 'fileId', 80), version = versionField(body), instruction = textField(body, 'instruction', 4000), actor = textField(body, 'actor', 40);
    const file = fileAt(this.current(), fileId, version), nodeId = textField(body, 'nodeId', 80);
    const node = flattenNodes(parseDocument(file.source, file.filename)).find(item => item.id === nodeId);
    if (!node) throw new Error('Die Auswahl ist nicht mehr aktuell.');
    const abort = new AbortController(); this.agentRequests.add(abort);
    const streamSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(150000), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await this.bridgeFetch.call(globalThis, endpoint, { method: 'POST', signal: streamSignal, credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.agentToken}` }, body: JSON.stringify({ filename: file.filename, source: file.source, nodeId, instruction }) });
      if (!response.ok) { this.agentRequests.delete(abort); return response; }
      if (!response.body) throw new Error('Die Verbindung zum Agenten wurde unterbrochen.');
    } catch (error) { this.agentRequests.delete(abort); throw error; }
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start: async (controller) => {
        const send = (event: string, data: unknown) => { if (!streamSignal.aborted) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); };
        const reader = response.body!.getReader(), decoder = new TextDecoder(), events = new EventStreamDecoder(1000000);
        const stop = () => { void reader.cancel().catch(() => {}); };
        streamSignal.addEventListener('abort', stop, { once: true });
        let replacement: string | undefined;
        try {
          streamSignal.throwIfAborted();
          while (true) {
            const { value, done } = await reader.read();
            for (const frame of events.push(done ? decoder.decode() : decoder.decode(value, { stream: true }), done)) {
              const data = JSON.parse(frame.data);
              if (frame.event === 'error') throw new Error(data.message);
              if (frame.event === 'delta' || frame.event === 'status') send(frame.event, data);
              if (frame.event === 'complete') replacement = data.replacement;
            }
            if (done) break;
          }
          if (typeof replacement !== 'string' || !replacement.trim() || replacement.length > 200000) throw new Error('Der Agent hat keine vollständige Änderung zurückgegeben.');
          streamSignal.throwIfAborted();
          const source = replaceNode(file.source, node, replacement); documentFromSource(source, file.filename);
          if (documentKind(file.filename) === 'adr' && readAdrStatus(source) !== readAdrStatus(file.source)) throw new Error('Der Agent darf den Entscheidungsstatus nicht ändern.');
          if (node.kind === 'adr-answer' && !/^\s+(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:/i.test(replacement)) throw new Error('Der Antwortbereich muss erhalten bleiben.');
          send('status', { message: 'Änderung in GitLab speichern …' });
          const state = await this.applyAgentChange(fileId, version, source, actor, instruction, streamSignal);
          send('complete', state);
        } catch (error) { send('error', { message: (error as Error).message }); }
        finally { streamSignal.removeEventListener('abort', stop); reader.releaseLock(); this.agentRequests.delete(abort); try { controller.close(); } catch { /* Reader cancelled. */ } }
      },
      cancel: () => abort.abort(),
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  async applyAgentChange(fileId: string, version: number, source: string, actor: string, instruction: string, signal?: AbortSignal) {
    return this.serialized(async () => {
      await this.refresh();
      signal?.throwIfAborted();
      if (this.readOnly) throw new Error('Du hast auf diesem Branch nur Leserechte. Die Agent-Änderung wird nicht gespeichert.');
      const previous = this.manifest!, next = structuredClone(previous);
      applyChange(next.workspace, fileId, version, source, actor, instruction, 'ai'); next.workspace.revision++;
      await this.persist(previous, next, `Hoospec: ${instruction.slice(0, 120)}`, signal); return this.emit();
    });
  }
  download = downloadDocument;
}
