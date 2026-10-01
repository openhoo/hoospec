export interface GitLabAccess {
  getToken(forceRefresh?: boolean): Promise<string>;
  disconnect(): void;
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number };
const expired = () => new Error('Die GitLab-Anmeldung ist abgelaufen. Bitte erneut anmelden. Dein Entwurf bleibt erhalten.');
/** Access and rotating refresh tokens never leave memory or enter the public config. */
export class GitLabOAuthAccess implements GitLabAccess {
  private accessToken: string;
  private refreshToken: string;
  private expiresAt: number;
  private refreshing?: Promise<string>;
  private closed = false;
  private abort = new AbortController();
  constructor(private readonly instance: string, private readonly clientId: string, tokens: Tokens, private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {
    if (!tokens.access_token) throw expired();
    this.accessToken = tokens.access_token; this.refreshToken = tokens.refresh_token || '';
    this.expiresAt = this.now() + (tokens.expires_in && Number.isFinite(tokens.expires_in) ? tokens.expires_in : 7200) * 1000;
  }
  getToken(forceRefresh = false): Promise<string> {
    if (this.closed) return Promise.reject(expired());
    if (!forceRefresh && this.now() < this.expiresAt - 30000) return Promise.resolve(this.accessToken);
    if (!this.refreshToken) return Promise.reject(expired());
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async refresh(): Promise<string> {
    try {
      const response = await this.fetcher.call(globalThis, this.instance + '/oauth/token', {
        method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.clientId, refresh_token: this.refreshToken }),
      });
      if (!response.ok) throw expired();
      const tokens = await response.json();
      if (this.closed || typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) throw expired();
      this.accessToken = tokens.access_token; this.refreshToken = tokens.refresh_token;
      this.expiresAt = this.now() + (Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in : 7200) * 1000;
      return this.accessToken;
    } catch { throw expired(); }
  }
  disconnect() { this.closed = true; this.accessToken = ''; this.refreshToken = ''; this.abort.abort(); }
}
