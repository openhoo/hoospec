import { randomBytes } from 'node:crypto';
import { ApiError } from './errors';
import type { CopilotModel, CopilotRuntime } from './copilot-runtime';

type Pending = { device: string; expires: number; interval: number; next: number; busy: boolean };
type Session = { token: string; expires: number; models: CopilotModel[]; aborts: Set<AbortController>; timer?: ReturnType<typeof setTimeout> };
export class CopilotBroker {
  private pending = new Map<string, Pending>();
  private sessions = new Map<string, Session>();
  constructor(private runtime: CopilotRuntime, private fetcher: typeof fetch = fetch, private now = Date.now) {}
  private clean() {
    for (const [key, value] of this.pending) if (value.expires <= this.now()) this.pending.delete(key);
    for (const [key, value] of this.sessions) if (value.expires <= this.now()) this.disconnect(key);
  }
  private async github(url: string, data: Record<string, string>) {
    const response = await this.fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!response.ok) throw new ApiError('GitHub-Anmeldung ist derzeit nicht erreichbar.', 502);
    return await response.json();
  }
  async start(clientId: string) {
    this.clean();
    if (!clientId) throw new ApiError('Am Copilot-Dienst fehlt HOOSPEC_COPILOT_CLIENT_ID. Bitte eine eigene GitHub OAuth App mit aktiviertem Device Flow konfigurieren.', 503);
    if (this.pending.size + this.sessions.size >= 100) throw new ApiError('Zu viele Copilot-Sitzungen. Bitte später erneut versuchen.', 429);
    const data = await this.github('https://github.com/login/device/code', { client_id: clientId, scope: 'read:user' });
    if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new ApiError('GitHub hat keinen gültigen Anmeldecode geliefert. Device Flow der OAuth App prüfen.', 502);
    this.clean();
    if (this.pending.size + this.sessions.size >= 100) throw new ApiError('Zu viele Copilot-Sitzungen.', 429);
    const key = randomBytes(32).toString('hex'), interval = Math.max(5, Math.min(60, Number(data.interval) || 5));
    this.pending.set(key, { device: data.device_code, expires: this.now() + Math.min(data.expires_in, 900) * 1000, interval, next: this.now() + interval * 1000, busy: false });
    return { session: key, userCode: data.user_code, verificationUrl: 'https://github.com/login/device', interval, expiresIn: Math.min(data.expires_in, 900) };
  }
  async poll(key: string, clientId: string) {
    this.clean(); const pending = this.pending.get(key);
    if (!pending) throw new ApiError('Anmeldung abgelaufen. Bitte erneut verbinden.', 401);
    if (pending.busy || pending.next > this.now()) return { status: 'pending', interval: pending.interval };
    pending.busy = true; pending.next = this.now() + pending.interval * 1000;
    try {
      const data = await this.github('https://github.com/login/oauth/access_token', { client_id: clientId, device_code: pending.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (this.pending.get(key) !== pending || pending.expires <= this.now()) throw new ApiError('Anmeldung wurde beendet.', 401);
      if (data.error === 'authorization_pending') return { status: 'pending', interval: pending.interval };
      if (data.error === 'slow_down') { pending.interval += 5; pending.next = this.now() + pending.interval * 1000; return { status: 'pending', interval: pending.interval }; }
      if (data.error || typeof data.access_token !== 'string' || !/^(gho_|ghu_)/.test(data.access_token)) { this.pending.delete(key); throw new ApiError('GitHub-Anmeldung abgelehnt oder abgelaufen. Bitte erneut verbinden.', 401); }
      const models = await this.runtime.models(data.access_token);
      if (!models.length) throw new ApiError('Für dieses Konto sind keine Copilot-Modelle verfügbar.', 403);
      if (this.pending.get(key) !== pending || pending.expires <= this.now()) throw new ApiError('Anmeldung wurde beendet.', 401);
      this.pending.delete(key); const session = randomBytes(32).toString('hex');
      const lifetime = Math.min(Number(data.expires_in) || 3600, 3600) * 1000;
      const timer = setTimeout(() => this.disconnect(session), lifetime); timer.unref();
      this.sessions.set(session, { token: data.access_token, expires: this.now() + lifetime, models, aborts: new Set(), timer });
      return { status: 'connected', session, models };
    } catch (error) { if (error instanceof ApiError && error.status !== 502) this.pending.delete(key); throw error; }
    finally { pending.busy = false; }
  }
  disconnect(key: string) { this.pending.delete(key); const session = this.sessions.get(key); for (const abort of session?.aborts || []) abort.abort(); if (session) { clearTimeout(session.timer); session.token = ''; } this.sessions.delete(key); }
  authorize(key: string, model: string) {
    this.clean(); const session = this.sessions.get(key);
    if (!session) throw new ApiError('Copilot-Anmeldung abgelaufen. Bitte erneut verbinden.', 401);
    if (!session.models.some(item => item.id === model)) throw new ApiError('Dieses Copilot-Modell ist nicht freigegeben.', 400);
    if (session.aborts.size) throw new ApiError('Copilot bearbeitet bereits eine Anfrage.', 429);
    return session;
  }
  async generate(key: string, model: string, messages: {role: string; content: string}[], delta: (text: string) => void, signal: AbortSignal) {
    const session = this.authorize(key, model);
    const abort = new AbortController(); session.aborts.add(abort);
    const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(Math.max(1, session.expires - this.now()))]);
    try { return await this.runtime.generate(session.token, model, messages, delta, combined); }
    finally { session.aborts.delete(abort); }
  }
}
