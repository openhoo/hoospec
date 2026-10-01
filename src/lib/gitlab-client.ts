import type { GitLabAccess } from './gitlab-auth';
export type GitLabConfig = { instance: string; project: string; branch: string; directory: string; specDirectory: string; adrDirectory: string; clientId: string; agentUrl?: string; requireMembership?: boolean };
export type RepositoryFile = { file_path: string; content: string; encoding: string; last_commit_id: string; size: number };
export type CommitAction = { action: 'create' | 'update'; file_path: string; content: string; last_commit_id?: string };
export function repositoryPath(input: string, allowEmpty = false) {
  const value = input.trim().replace(/^\/+|\/+$/g, '');
  if ((!value && !allowEmpty) || value.split('/').some(part => part === '..' || part === '.') || /[\x00-\x1f\\]/.test(value)) throw new Error('Bitte einen gültigen Repository-Pfad angeben.');
  return value;
}
export function normalizeGitLabConfig(input: GitLabConfig): GitLabConfig {
  const url = new URL(input.instance);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('GitLab braucht eine HTTPS-Adresse; HTTP ist für lokale Testinstanzen erlaubt.');
  if (input.agentUrl) {
    const agent = new URL(input.agentUrl);
    const agentLocal = ['localhost', '127.0.0.1', '[::1]'].includes(agent.hostname) || agent.hostname.endsWith('.localhost');
    if (agent.username || agent.password || agent.search || agent.hash || (agent.protocol !== 'https:' && !(agent.protocol === 'http:' && agentLocal))) throw new Error('Bitte eine sichere URL für den Agent-Dienst angeben.');
  }
  if (typeof input.project !== 'string' || typeof input.branch !== 'string' || !input.project.trim() || !input.branch.trim()) throw new Error('Bitte Projekt und Branch angeben.');
  const instance = url.href.replace(/\/$/, '');
  let project = input.project.trim();
  if (/^https?:\/\//i.test(project)) {
    const link = new URL(project);
    const prefix = url.pathname.replace(/\/$/, '') + '/';
    if (link.origin !== url.origin || !link.pathname.startsWith(prefix) || link.username || link.password) throw new Error('Der Projekt-Link gehört nicht zu dieser GitLab-Instanz.');
    project = decodeURIComponent(link.pathname.slice(prefix.length).split('/-/')[0]).replace(/\.git$/, '');
  }
  project = repositoryPath(project);
  if (/[?#\x7f]/.test(project) || project.length > 512 || input.branch.length > 255 || /[\x00-\x1f\x7f]/.test(input.branch)) throw new Error('Bitte ein gültiges Projekt und einen gültigen Branch angeben.');
  return { instance, project, branch: input.branch.trim(), directory: repositoryPath(input.directory), specDirectory: repositoryPath(input.specDirectory, true), adrDirectory: repositoryPath(input.adrDirectory, true), clientId: (input.clientId || '').trim(), ...(input.agentUrl ? { agentUrl: input.agentUrl.trim() } : {}), requireMembership: input.requireMembership === true };

}
export class GitLabError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function decodeRepositoryFile(file: RepositoryFile) {
  if (file.size > 16000000) throw new Error('Die Repository-Datei ist zu groß (maximal 16 MB).');
  if (file.encoding !== 'base64') throw new Error('Unbekanntes GitLab-Dateiformat.');
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(file.content.replace(/\s/g, '')), char => char.charCodeAt(0)));
}
export class GitLabClient {
  readonly config: GitLabConfig;
  private token: string;
  private access?: GitLabAccess;
  readOnly = false;
  constructor(config: GitLabConfig, token: string | GitLabAccess, private readonly fetcher: typeof fetch = fetch) {
    this.config = normalizeGitLabConfig(config); this.token = typeof token === 'string' ? token.trim() : '';
    if (typeof token !== 'string') this.access = token;
    if (!this.token && !this.access) throw new Error('Bitte bei GitLab anmelden oder einen Zugriffstoken angeben.');
  }
  disconnect() { this.token = ''; this.access?.disconnect(); this.access = undefined; }
  async api<T>(endpoint: string, init?: RequestInit): Promise<{ data: T; nextPage: string }> {
    if (!this.token && !this.access) throw new Error('Bitte erneut mit GitLab verbinden.');
    const token = this.access ? await this.access.getToken() : this.token;
    let response: Response;
    try { response = await this.fetcher.call(globalThis, `${this.config.instance}/api/v4${endpoint}`, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), credentials: 'omit', redirect: 'error', headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } }); }
    catch { throw new Error('GitLab ist nicht erreichbar. Bitte Adresse und CORS-Freigabe für diese Pages-Adresse prüfen.'); }
    if (!response.ok) {
      const message = response.status === 401 ? 'Die GitLab-Anmeldung ist abgelaufen oder ungültig.' : response.status === 403 ? 'GitLab verweigert den Zugriff. Bitte Projektberechtigung, API-Scope und Branch-Schutz prüfen.' : response.status === 404 ? 'Projekt, Branch oder Datei wurde in GitLab nicht gefunden.' : init?.method === 'POST' ? 'GitLab hat den Commit abgelehnt. Der Branch oder eine Datei könnte inzwischen geändert worden sein. Bitte den aktuellen Stand prüfen.' : `GitLab-Anfrage fehlgeschlagen (HTTP ${response.status}).`;
      throw new GitLabError(message, response.status);
    }
    return { data: await response.json() as T, nextPage: response.headers.get('x-next-page') || '' };
  }
  private get projectPath() { return `/projects/${encodeURIComponent(this.config.project)}`; }
  async verifyMembership() {
    if (!this.config.requireMembership) { this.readOnly = false; return; }
    const { data } = await this.api<{ permissions?: { project_access?: { access_level: number } | null; group_access?: { access_level: number } | null } }>(this.projectPath);
    const level = Math.max(data.permissions?.project_access?.access_level || 0, data.permissions?.group_access?.access_level || 0);
    if (level < 10) throw new GitLabError('Dieses Studio ist nur für Mitglieder des zugehörigen GitLab-Projekts freigegeben.', 403);
    this.readOnly = level < 30;
  }
  async head(): Promise<string> {
    const { data } = await this.api<{ commit: { id: string }; can_push?: boolean }>(`${this.projectPath}/repository/branches/${encodeURIComponent(this.config.branch)}`);
    this.readOnly = this.readOnly || data.can_push === false;
    return data.commit.id;
  }
  async file(path: string, ref: string): Promise<RepositoryFile | null> {
    try { return (await this.api<RepositoryFile>(`${this.projectPath}/repository/files/${encodeURIComponent(repositoryPath(path))}?ref=${encodeURIComponent(ref)}`)).data; }
    catch (error) { if (error instanceof GitLabError && error.status === 404) return null; throw error; }
  }
  private async treePage(ref: string, page: string, directory: string) {
    try { return await this.api<{ type: string; path: string }[]>(`${this.projectPath}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}${directory ? `&path=${encodeURIComponent(directory)}` : ''}`); }
    catch (error) { if (directory && error instanceof GitLabError && error.status === 404) return { data: [], nextPage: '' }; throw error; }
  }
  async tree(ref: string): Promise<string[]> {
    const paths: string[] = []; let page = '1';
    for (let count = 0; page; count++) {
      if (count >= 200) throw new Error('Das Repository ist zu groß für die automatische Suche. Bitte ein kleineres Spec-Verzeichnis verwenden.');
      const { data, nextPage } = await this.treePage(ref, page, this.config.specDirectory);
      paths.push(...data.filter(item => item.type === 'blob').map(item => item.path)); page = nextPage;
    }
    // ADRs may live outside the spec subtree.
    if (this.config.specDirectory && this.config.adrDirectory && this.config.adrDirectory !== this.config.specDirectory && !this.config.adrDirectory.startsWith(this.config.specDirectory + '/')) {
      let page = '1';
      for (let count = 0; page; count++) {
        if (count >= 200) throw new Error('Das ADR-Verzeichnis ist zu groß für die automatische Suche. Bitte ein kleineres Verzeichnis verwenden.');
        const { data, nextPage } = await this.treePage(ref, page, this.config.adrDirectory);
        paths.push(...data.filter(item => item.type === 'blob').map(item => item.path)); page = nextPage;
      }
    }
    return [...new Set(paths)];
  }
  async commit(actions: CommitAction[], message: string): Promise<string> {
    const { data } = await this.api<{ id: string }>(`${this.projectPath}/repository/commits`, { method: 'POST', body: JSON.stringify({ branch: this.config.branch, commit_message: `${message}\n\n[skip ci]`, actions }) });
    return data.id;
  }
}
