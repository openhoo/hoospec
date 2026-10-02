import { CopilotRunnerConnection } from './copilot-runner';
import type { CopilotSession } from './copilot-connection';
import { BrowserDraftStore, MemoryDraftStore, type RepositoryDraftStore } from './repository-draft';
import type { GitLabAccess } from './gitlab-auth';
import { GitLabClient, decodeRepositoryFile, normalizeGitLabConfig, repositoryPath, type GitLabConfig, type RepositoryFile, type CommitAction, GitLabError } from './gitlab-client';
import { migrateWorkspace } from './workspace-migration';
import { applyWorkspaceAction } from './workspace-actions';
import { applyChange, fileAt } from './workspace-core';
import { readAdrStatus } from './adr';
import { textField, versionField } from './http';
import { documentFromSource, renderDocument } from './json-document';
import { flattenNodes, replaceNode } from './gherkin';
import { EventStreamDecoder } from './event-stream';
import { parseDocument, documentKind } from './document';
import { downloadDocument, type BackendListener, type StudioBackend, type ReviewSession } from './studio-backend';
import type { AIModel, Snapshot, Workspace } from './types';

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
function matchesManifest(file: RepositoryFile, manifest: RepositoryManifest) {
  return JSON.stringify(parseRepositoryManifest(decodeRepositoryFile(file))) === JSON.stringify(parseRepositoryManifest(JSON.stringify(manifest)));
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
  get hasDraft() { return this.changes().length > 0 || !!this.publication; }
  get readOnly() { return this.client.readOnly; }
  get label() { return this.readOnly ? 'Mit GitLab verbunden · Nur lesen' : 'Mit GitLab verbunden'; }
  readonly client: GitLabClient;
  private manifest?: RepositoryManifest;
  private base?: RepositoryManifest;
  private conflict = false;
  private incoming?: RepositoryManifest;
  private restored = false;
  private readonly localDraft: RepositoryDraftStore;
  private review?: ReviewSession;
  private publication?: { branch: string; sha: string; manifest: RepositoryManifest; title: string };
  private canonical: RepositoryFile | null = null;
  private head = '';
  private revision = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<BackendListener>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private agentRequests = new Set<AbortController>();
  constructor(config: GitLabConfig, token: string | GitLabAccess, fetcher?: typeof fetch, private agentToken = '', private readonly bridgeFetch: typeof fetch = fetch, draftStore?: RepositoryDraftStore) {
    this.client = new GitLabClient(config, token, fetcher);
    const c = this.client.config;
    this.localDraft = draftStore || (typeof window === 'undefined' ? new MemoryDraftStore() : new BrowserDraftStore(JSON.stringify([c.instance, c.project, c.branch, c.directory])));
  }
  createCopilotLogin(clientId: string) { return new CopilotRunnerConnection(this.client, clientId, this.bridgeFetch); }
  private bridgeModels: AIModel[] = [];
  private bridgeModel = '';
  private bridgeChecked = 0;
  private bridgeGeneration = 0;
  private bridgeProbe?: Promise<void>;
  private async verifyAgent(force = false) {
    if (this.copilot?.connected || !this.client.config.agentUrl || !this.agentToken || this.stopped) return;
    if (this.bridgeProbe) return this.bridgeProbe;
    if (!force && Date.now() - this.bridgeChecked < 10000) return;
    const generation = this.bridgeGeneration;
    const operation = (async () => {
      let models: AIModel[] = [], model = '';
      try {
        const response = await this.bridgeFetch.call(globalThis, this.client.config.agentUrl!, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(7000), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.agentToken}` }, body: JSON.stringify({ action: 'connection' }) });
        if (response.ok) {
          const text = await response.text(); if (text.length > 100000) throw new Error();
          const data = JSON.parse(text);
          if (data.aiReady === true && Array.isArray(data.aiModels) && data.aiModels.length && data.aiModels.length <= 200 && data.aiModels.every((item: AIModel) => typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200 && typeof item.name === 'string' && item.name.length <= 200) && data.aiModels.some((item: AIModel) => item.id === data.aiModel)) { models = data.aiModels; model = data.aiModel; }
        }
      } catch { /* Addresses and tokens do not establish an AI connection. */ }
      if (!this.stopped && generation === this.bridgeGeneration) { this.bridgeModels = models; this.bridgeModel = model; this.bridgeChecked = Date.now(); }
    })();
    this.bridgeProbe = operation;
    try { await operation; } finally { if (this.bridgeProbe === operation) this.bridgeProbe = undefined; }
  }
  private copilot?: CopilotSession;
  get copilotConnection() { return this.copilot; }
  configureCopilot(connection?: CopilotSession) {
    if (this.copilot !== connection) { this.copilot?.onDisconnect(() => {}); this.copilot?.disconnect(); this.copilot = connection; this.bridgeGeneration++; this.bridgeChecked = 0; this.bridgeModels = []; this.bridgeModel = ''; this.bridgeProbe = undefined; }
    connection?.onDisconnect(() => { this.revision++; if (this.manifest && !this.stopped) this.emit(); });
    this.revision++; this.emit();
  }
  private get path() { return `${this.client.config.directory}/workspace.json`; }
  private serialized<T>(work: () => Promise<T>) { const next = this.queue.then(work); this.queue = next.catch(() => {}); return next; }
  private emit() { const state = this.current(); for (const listener of this.listeners) { listener.snapshot(state); listener.connection(true); } return state; }
  private changes() {
    if (!this.manifest || !this.base) return [];
    return this.manifest.workspace.files.flatMap(file => {
      const old = this.base!.workspace.files.find(item => item.id === file.id);
      const before = old ? renderDocument(old.document) : '', after = renderDocument(file.document);
      const shared = this.incoming?.workspace.files.find(item => item.id === file.id);
      return old && before === after && old.reviewed === file.reviewed ? [] : [{ filename: file.filename, path: this.manifest!.paths[file.id], before: shared ? renderDocument(shared.document) : before, after }];
    });
  }
  private async branchPrefix() {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.client.config.directory));
    return `hoospec/${Array.from(new Uint8Array(hash)).slice(0, 8).map(n => n.toString(16).padStart(2, '0')).join('')}/`;
  }
  private current() { if (!this.manifest) throw new Error('Repository noch nicht geladen.'); return { ...snapshotOf(this.manifest.workspace, this.revision), aiReady: !!this.copilot?.connected || !!this.bridgeModels.length, aiModels: this.copilot?.connected ? this.copilot.models : this.bridgeModels, aiModel: this.copilot?.connected ? this.copilot.model : this.bridgeModel, model: this.copilot?.connected ? `Copilot · ${this.copilot.model}` : this.bridgeModels.length ? this.bridgeModel : '', repository: {
    project: this.client.config.project, targetBranch: this.client.config.branch, branch: this.publication?.branch || this.review?.source_branch || this.client.config.branch,
    changes: this.changes(), conflict: this.conflict, submissionPending: !!this.publication,
    ...(this.review ? { mergeRequest: { iid: this.review.iid, title: this.review.title, url: this.review.web_url, state: this.review.state } } : {}),
  } }; }
  private async refresh() {
    if (this.stopped) throw new Error('Repository-Verbindung wurde getrennt.');
    const previousReadOnly = this.readOnly;
    await this.client.verifyMembership();
    if (this.publication) return; // A successful commit with an unconfirmed MR must remain retryable.
    if (this.review) {
      const latest = await this.client.mergeRequest(this.review.iid);
      if (latest.state !== 'opened') {
        if (this.changes().length) { this.review = latest; this.conflict = true; this.revision++; return; }
        this.review = undefined; this.head = '';
      } else this.review = latest;
    }
    const head = await this.client.head(this.review?.source_branch);
    if (previousReadOnly !== this.readOnly) this.revision++;
    if (head === this.head && this.manifest) return;
    const canonical = await this.client.file(this.path, head);
    let manifest: RepositoryManifest;
    if (canonical) manifest = parseRepositoryManifest(decodeRepositoryFile(canonical));
    else {
      const paths = (await this.client.tree(head)).filter(path => /\.feature$/i.test(path) && (!this.client.config.specDirectory || path.startsWith(this.client.config.specDirectory + '/')) || (/\.(md|markdown)$/i.test(path) && !!this.client.config.adrDirectory && path.startsWith(this.client.config.adrDirectory + '/')));
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
    if (this.changes().length && this.manifest) { this.incoming = manifest; this.conflict = true; this.revision++; return; }
    this.incoming = undefined;
    this.canonical = canonical; this.manifest = manifest; this.base = structuredClone(manifest); this.head = head; this.conflict = false; this.revision++;
  }
  private sessionState() {
    return { schemaVersion: 1, manifest: this.manifest, base: this.base, head: this.head, reviewIid: this.review?.iid, publication: this.publication };
  }
  private async saveSession() { await this.localDraft.write(this.sessionState()); }
  private async restoreSession() {
    if (this.restored) return;
    const saved = await this.localDraft.read();
    if (saved && typeof saved === 'object' && 'schemaVersion' in saved && saved.schemaVersion === 1 && 'manifest' in saved && 'base' in saved && 'head' in saved) {
      const record = saved as { manifest: unknown; base: unknown; head: string; reviewIid?: number; publication?: { branch: string; sha: string; manifest: unknown; title: string } };
      const manifest = parseRepositoryManifest(JSON.stringify(record.manifest)), base = parseRepositoryManifest(JSON.stringify(record.base));
      if (typeof record.head !== 'string' || !record.head || record.head.length > 255) throw new Error('Der lokale Entwurf enthält keinen gültigen Ausgangsstand.');
      const review = record.reviewIid ? await this.client.mergeRequest(record.reviewIid) : undefined;
      const prefix = await this.branchPrefix();
      if (review && (review.target_branch !== this.client.config.branch || !review.source_branch.startsWith(prefix))) throw new Error('Der lokale Entwurf gehört zu einem anderen Workspace.');
      const publication = record.publication ? { ...record.publication, manifest: parseRepositoryManifest(JSON.stringify(record.publication.manifest)) } : undefined;
      if (publication && (!publication.branch.startsWith(prefix) || typeof publication.sha !== 'string' || typeof publication.title !== 'string')) throw new Error('Ungültige lokale Einreichung.');
      const canonical = await this.client.file(this.path, record.head);
      this.manifest = manifest; this.base = base; this.head = record.head; this.canonical = canonical; this.review = review; this.publication = publication; this.revision++;
      await this.refresh();
    }
    this.restored = true;
  }
  load(): Promise<Snapshot> { return this.serialized(async () => { await this.refresh(); await this.restoreSession(); await this.saveSession(); await this.verifyAgent(); return this.emit(); }); }
  subscribe(listener: BackendListener) {
    this.listeners.add(listener);
    if (this.manifest) { listener.snapshot(this.current()); listener.connection(true); }
    if (!this.timer) this.timer = setInterval(() => {
      void this.load().catch(error => { for (const item of this.listeners) { item.connection(false); item.error((error as Error).message); } });
    }, 10000);
    return () => { this.listeners.delete(listener); if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = undefined; } };
  }
  configureAgent(url: string, token: string) {
    const normalized = normalizeGitLabConfig({ ...this.client.config, agentUrl: url }).agentUrl;
    this.copilot?.disconnect(); this.copilot = undefined;
    this.client.config.agentUrl = normalized;
    this.agentToken = token.trim(); this.bridgeGeneration++; this.bridgeModels = []; this.bridgeModel = ''; this.bridgeChecked = 0; this.bridgeProbe = undefined; this.revision++; this.emit();
    return this.verifyAgent(true).then(() => { this.revision++; this.emit(); if (!this.bridgeModels.length) throw new Error('Der AI-Dienst ist nicht verbunden. Adresse, Zugang und verfügbare Modelle prüfen.'); });
  }
  disconnect() { this.bridgeGeneration++; this.bridgeModels = []; this.bridgeModel = ''; this.copilot?.disconnect(); this.agentToken = ''; this.stopped = true; for (const abort of this.agentRequests) abort.abort(); this.agentRequests.clear(); this.client.disconnect(); if (this.timer) clearInterval(this.timer); this.listeners.clear(); }
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
      if (this.publication) throw new Error('Der Branch ist gespeichert, aber der Merge Request noch nicht bestätigt. Bitte zuerst die Einreichung erneut versuchen.');
      const next = structuredClone(current);
      applyWorkspaceAction(next.workspace, body); next.workspace.revision++;
      await this.acceptDraft(next);
      return this.emit();
    });
  }
  private async acceptDraft(next: RepositoryManifest) {
    for (const file of next.workspace.files) {
      const directory = documentKind(file.filename) === 'adr' ? this.client.config.adrDirectory : this.client.config.specDirectory;
      next.paths[file.id] ||= [directory, file.filename].filter(Boolean).join('/');
    }
    if (new Set(next.workspace.files.map(file => next.paths[file.id])).size !== next.workspace.files.length) throw new Error('Dokumente dürfen nicht denselben Repository-Pfad verwenden.');
    if (new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n').byteLength > 16000000) throw new Error('Der JSON-Workspace mit Verlauf ist zu groß (maximal 16 MB). Bitte einen kleineren Dokumentbestand verwalten.');
    const previous = this.manifest; this.manifest = next;
    try { await this.saveSession(); }
    catch (error) { this.manifest = previous; throw error; }
    this.revision++;
  }
  private async actions(previous: RepositoryManifest, next: RepositoryManifest) {
    const manifestSource = JSON.stringify(next, null, 2) + '\n';
    const actions: CommitAction[] = [];
    for (const file of next.workspace.files) {
      const old = previous.workspace.files.find(item => item.id === file.id);
      const content = renderDocument(file.document);
      const path = next.paths[file.id];

      const remote = await this.client.file(path, this.head);
      if (old && !remote) throw new Error(`Die Datei ${path} wurde außerhalb von Hoospec entfernt. Sie wird nicht neu angelegt.`);
      if (remote && (!old || decodeRepositoryFile(remote) !== renderDocument(old.document))) throw new Error(`Die Datei ${path} wurde außerhalb von Hoospec geändert. Sie wird nicht überschrieben.`);
      if (!remote || decodeRepositoryFile(remote) !== content) actions.push({ action: remote ? 'update' : 'create', file_path: path, content, ...(remote ? { last_commit_id: remote.last_commit_id } : {}) });
    }
    actions.push({ action: this.canonical ? 'update' : 'create', file_path: this.path, content: manifestSource, ...(this.canonical ? { last_commit_id: this.canonical.last_commit_id } : {}) });
    return actions;
  }
  private async switchReview(review: ReviewSession | undefined, discard = false) {
    const previous = { review: this.review, manifest: this.manifest, base: this.base, head: this.head, canonical: this.canonical, conflict: this.conflict };
    try {
      if (discard) this.manifest = structuredClone(this.base!);
      this.review = review; this.head = ''; this.conflict = false;
      await this.refresh(); await this.saveSession(); return this.emit();
    } catch (error) {
      Object.assign(this, previous); this.revision++; this.emit(); throw error;
    }
  }
  readonly repository = {
    submit: (title: string) => this.serialized(async () => {
      if (!title.trim() || title.trim().length > 200) throw new Error('Bitte einen Titel mit maximal 200 Zeichen eingeben.');
      await this.refresh();
      if (this.readOnly) throw new Error('Für einen Merge Request brauchst du Schreibrechte im Projekt.');
      if (this.conflict) throw new Error('Der gemeinsame Stand wurde geändert. Dein Entwurf bleibt erhalten. Bitte im Dialog den gewünschten Stand auswählen.');
      if (!this.publication) {
        if (!this.changes().length) throw new Error('Keine Änderungen zum Einreichen.');
        const branch = this.review?.source_branch || (await this.branchPrefix()) + this.sessionId;
        const next = structuredClone(this.manifest!);
        const actions = await this.actions(this.base!, next);
        // Record intent before the POST: a lost response must not duplicate an accepted commit.
        this.publication = { branch, sha: '', manifest: next, title: title.trim() };
        try { await this.saveSession(); } catch (error) { this.publication = undefined; throw error; }
        try { this.publication.sha = await this.client.commit(actions, title.trim(), branch, this.review ? undefined : this.head); }
        catch (error) {
          if (error instanceof GitLabError && error.status >= 400 && error.status < 500) this.publication = undefined;
          await this.saveSession(); this.revision++; this.emit(); throw error;
        }
        await this.saveSession(); this.revision++; this.emit();
      }
      const publication = this.publication;
      if (!publication.sha) {
        let sha = '';
        try { sha = await this.client.head(publication.branch); }
        catch (error) { if (!(error instanceof GitLabError && error.status === 404)) throw error; }
        const remote = sha ? await this.client.file(this.path, sha) : null;
        if (remote && matchesManifest(remote, publication.manifest)) publication.sha = sha;
        else if (!sha || (this.review && sha === this.head)) {
          publication.sha = await this.client.commit(await this.actions(this.base!, publication.manifest), publication.title, publication.branch, this.review ? undefined : this.head);
        } else throw new Error('Der Entwurfs-Branch wurde inzwischen geändert. Es wird nichts überschrieben. Bitte den Branch in GitLab prüfen.');
      }
      const requests = await this.client.mergeRequests(publication.branch);
      if (this.review && !requests.length) throw new Error('Der Merge Request wurde inzwischen geschlossen oder gemerged. Der Commit bleibt auf seinem Branch erhalten. Bitte in GitLab prüfen.');
      const review = requests[0] || await this.client.createMergeRequest(publication.branch, publication.title);
      if (this.stopped) throw new Error('Repository-Verbindung wurde getrennt.');
      const remote = await this.client.file(this.path, publication.sha);
      if (!remote || !matchesManifest(remote, publication.manifest)) throw new Error('Der gespeicherte Branch konnte noch nicht bestätigt werden. Bitte erneut versuchen.');
      this.review = review; this.manifest = publication.manifest; this.base = structuredClone(publication.manifest);
      this.head = publication.sha; this.canonical = remote; this.publication = undefined; this.conflict = false; this.revision++;
      await this.saveSession(); return this.emit();
    }),
    discard: () => this.serialized(async () => {
      if (this.publication) throw new Error('Der Branch wurde bereits gespeichert. Bitte die Einreichung abschließen.');
      if (!this.base) throw new Error('Repository noch nicht geladen.');
      return this.switchReview(this.review, true);
    }),
    resolveConflict: () => this.serialized(async () => {
      if (!this.conflict || this.publication) throw new Error('Kein auflösbarer Konflikt.');
      const local = structuredClone(this.manifest!), changed = this.changes();
      const previous = { review: this.review, manifest: this.manifest, base: this.base, head: this.head, canonical: this.canonical, conflict: this.conflict };
      try {
        this.manifest = structuredClone(this.base!); this.head = ''; this.conflict = false;
        await this.refresh();
        if (this.readOnly) throw new Error('Für eine Bearbeitung brauchst du Schreibrechte im Projekt.');
        const next = structuredClone(this.manifest!);
        for (const change of changed) {
          const incoming = local.workspace.files.find(file => file.filename === change.filename)!;
          const existing = next.workspace.files.find(file => file.id === incoming.id);
          if (existing) {
            if (renderDocument(existing.document) !== change.after) applyChange(next.workspace, existing.id, existing.version, change.after, local.workspace.changes.find(item => item.fileId === incoming.id)?.actor || 'Team', 'Eigenen Entwurf nach Konflikt beibehalten', 'manual');
            if (existing.reviewed !== incoming.reviewed) applyWorkspaceAction(next.workspace, { action: 'review', fileId: existing.id, version: existing.version, actor: 'Team' });
          } else {
            if (next.workspace.files.some(file => file.filename === incoming.filename)) throw new Error('Ein neues Dokument mit diesem Namen wurde inzwischen angelegt. Bitte umbenennen.');
            next.workspace.files.push(incoming); next.paths[incoming.id] = local.paths[incoming.id];
          }
        }
        next.workspace.revision++; await this.acceptDraft(next); return this.emit();
      } catch (error) { Object.assign(this, previous); this.revision++; this.emit(); throw error; }
    }),
    sessions: async () => {
      const prefix = await this.branchPrefix();
      return (await this.client.mergeRequests()).filter(review => review.source_branch.startsWith(prefix));
    },
    join: (iid: number) => this.serialized(async () => {
      if (this.changes().length || this.publication) throw new Error('Bitte deinen Entwurf zuerst einreichen oder verwerfen.');
      const review = await this.client.mergeRequest(iid);
      if (review.state !== 'opened' || review.target_branch !== this.client.config.branch || !review.source_branch.startsWith(await this.branchPrefix())) throw new Error('Dieser Merge Request gehört nicht zu diesem Hoospec-Workspace.');
      return this.switchReview(review);
    }),
    leave: () => this.serialized(async () => {
      if (this.changes().length || this.publication) throw new Error('Bitte deinen Entwurf zuerst einreichen oder verwerfen.');
      return this.switchReview(undefined);
    }),
  };
  async agent(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    await this.load();
    if (this.publication) return Response.json({ error: 'Bitte zuerst die Einreichung abschließen.' }, { status: 409 });
    if (this.readOnly) return Response.json({ error: 'Du hast auf diesem Branch nur Leserechte.' }, { status: 403 });
    const endpoint = this.client.config.agentUrl;
    if (!this.copilot?.connected && (!endpoint || !this.agentToken || !this.bridgeModels.length)) return Response.json({ error: 'Bitte unter Repository-Verbindung den serverseitigen Agent-Dienst und seinen Zugang einrichten.' }, { status: 503 });
    const model = body.model === undefined ? this.current().aiModel : body.model;
    if (typeof model !== 'string' || !this.current().aiModels.some(item => item.id === model)) return Response.json({ error: 'Dieses AI-Modell ist nicht verfügbar.' }, { status: 400 });
    const fileId = textField(body, 'fileId', 80), version = versionField(body), instruction = textField(body, 'instruction', 4000), actor = textField(body, 'actor', 40);
    const file = fileAt(this.current(), fileId, version), nodeId = textField(body, 'nodeId', 80);
    const node = flattenNodes(parseDocument(file.source, file.filename)).find(item => item.id === nodeId);
    if (!node) throw new Error('Die Auswahl ist nicht mehr aktuell.');
    const abort = new AbortController(); this.agentRequests.add(abort);
    const streamSignal = AbortSignal.any([abort.signal, AbortSignal.timeout(150000), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = this.copilot?.connected ? await this.copilot.agent({ filename: file.filename, source: file.source, nodeId, instruction, model }, streamSignal) : await this.bridgeFetch.call(globalThis, endpoint!, { method: 'POST', signal: streamSignal, credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.agentToken}` }, body: JSON.stringify({ filename: file.filename, source: file.source, nodeId, instruction, model }) });
      if (!response.ok) { if (!this.copilot?.connected && [401, 403, 503].includes(response.status)) { this.bridgeModels = []; this.bridgeModel = ''; this.bridgeChecked = Date.now(); this.revision++; this.emit(); } this.agentRequests.delete(abort); return response; }
      if (!response.body) throw new Error('Die Verbindung zum Agenten wurde unterbrochen.');
    } catch (error) { if (!this.copilot?.connected) { this.bridgeModels = []; this.bridgeModel = ''; this.bridgeChecked = Date.now(); this.revision++; this.emit(); } this.agentRequests.delete(abort); throw error; }
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
          if (node.kind === 'step' && !flattenNodes(parseDocument(source, file.filename)).some(item => item.kind === 'step' && item.start === node.start)) throw new Error('Der Agent muss einen gültigen Gherkin-Schritt zurückgeben.');
          if (documentKind(file.filename) === 'adr' && readAdrStatus(source) !== readAdrStatus(file.source)) throw new Error('Der Agent darf den Entscheidungsstatus nicht ändern.');
          if (node.kind === 'adr-answer' && !/^\s+(?:\*\*)?(?:Antwort|Answer)(?:\*\*)?\s*:/i.test(replacement)) throw new Error('Der Antwortbereich muss erhalten bleiben.');
          send('status', { message: 'Änderung zum Entwurf hinzufügen …' });
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
      if (this.publication) throw new Error('Bitte zuerst die Einreichung abschließen.');
      const next = structuredClone(this.manifest!);
      applyChange(next.workspace, fileId, version, source, actor, instruction, 'ai'); next.workspace.revision++;
      await this.acceptDraft(next); return this.emit();
    });
  }
  download = downloadDocument;
}
