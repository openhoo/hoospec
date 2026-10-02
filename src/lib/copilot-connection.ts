export type CopilotModel = {id: string; name: string};
export interface CopilotSession {
  connected: boolean; models: CopilotModel[]; model: string;
  onDisconnect(callback: () => void): void;
  start(): Promise<CopilotLogin>;
  poll(): Promise<{connected: boolean; interval: number}>;
  agent(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
  disconnect(): void;
}
export type CopilotLogin = { userCode: string; verificationUrl: string; interval: number; expiresIn: number };
export function copilotUrl(input: string) {
  const url = new URL(input), local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Bitte eine sichere Adresse für den Copilot-Dienst angeben.');
  return url.toString();
}
/** The browser holds only an opaque session credential. GitHub tokens stay at the relay. */
export class CopilotConnection {
  private session = '';
  private generation = 0;
  private active = new Set<AbortController>();
  private ready = false;
  private onExpired?: () => void;
  models: CopilotModel[] = [];
  model = '';
  readonly url: string;
  constructor(url: string, private fetcher: typeof fetch = fetch) { this.url = copilotUrl(url); }
  get connected() { return this.ready; }
  onDisconnect(callback: () => void) { this.onExpired = callback; }
  private async request(body: Record<string, unknown>, signal?: AbortSignal, credential = this.session) {
    const abort = new AbortController(); this.active.add(abort);
    try {
      return await this.fetcher.call(globalThis, this.url, { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(body.action === 'agent' ? 150000 : 30000), ...(signal ? [signal] : [])]), headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(body) });
    } catch { throw new Error('Copilot-Dienst nicht erreichbar. Bitte Dienstadresse und Freigabe für diese Studio-Adresse prüfen.'); }
    finally { this.active.delete(abort); }
  }
  private async json(body: Record<string, unknown>) {
    const response = await this.request(body); const data = await response.json();
    if (!response.ok) { if (response.status === 401) this.disconnect(); throw new Error(typeof data.error === 'string' ? data.error : 'Copilot-Verbindung fehlgeschlagen.'); }
    return data;
  }
  async start(): Promise<CopilotLogin> {
    this.disconnect(); const generation = this.generation;
    const data = await this.json({ action: 'start' });
    if (generation !== this.generation) throw new Error('Anmeldung abgebrochen.');
    if (!/^[a-f0-9]{64}$/.test(data.session) || data.verificationUrl !== 'https://github.com/login/device' || typeof data.userCode !== 'string') throw new Error('Ungültige Copilot-Anmeldung.');
    this.session = data.session;
    return { userCode: data.userCode, verificationUrl: data.verificationUrl, interval: Math.max(5, Number(data.interval) || 5), expiresIn: Number(data.expiresIn) || 900 };
  }
  async poll() {
    const generation = this.generation, data = await this.json({ action: 'poll' });
    if (generation !== this.generation) throw new Error('Anmeldung abgebrochen.');
    if (data.status === 'connected') {
      if (!/^[a-f0-9]{64}$/.test(data.session) || !Array.isArray(data.models) || !data.models.length || data.models.some((model: CopilotModel) => typeof model.id !== 'string' || typeof model.name !== 'string')) throw new Error('Ungültige Copilot-Modellliste.');
      this.session = data.session; this.models = data.models; this.model = data.models[0].id; this.ready = true;
    }
    return { connected: this.ready, interval: Math.max(5, Number(data.interval) || 5) };
  }
  async agent(body: Record<string, unknown>, signal?: AbortSignal) {
    if (!this.ready) return Response.json({ error: 'Bitte erneut mit Copilot verbinden.' }, { status: 401 });
    const model = body.model === undefined ? this.model : body.model;
    if (!this.models.some(item => item.id === model)) return Response.json({ error: 'Dieses Copilot-Modell ist nicht verfügbar.' }, { status: 400 });
    const response = await this.request({ ...body, action: 'agent', model }, signal).catch(error => { if (!signal?.aborted) this.disconnect(); throw error; });
    if ([401, 403].includes(response.status)) this.disconnect();
    return response;
  }
  disconnect() {
    const session = this.session; this.session = ''; this.ready = false; this.models = []; this.model = ''; this.generation++;
    for (const abort of this.active) abort.abort(); this.active.clear(); this.onExpired?.();
    if (session) void this.request({ action: 'disconnect' }, undefined, session).catch(() => {});
  }
}
