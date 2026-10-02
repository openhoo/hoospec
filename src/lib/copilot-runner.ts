import type { GitLabClient } from './gitlab-client';
import { GitLabError } from './gitlab-client';
import type { CopilotSession, CopilotModel, CopilotLogin } from './copilot-connection';
import { loginKeys, openCredential, copilotEndpoint, type CopilotCredential } from './copilot-envelope';
import { parseDocument } from './document';
import { flattenNodes, sourceOf } from './gherkin';
import { agentMessages } from './agent-prompt';
import { EventStreamDecoder } from './event-stream';
import { alignAgentIndent, normalizeAgentSource } from './agent-output';
import { documentKind } from './document';

type Job = {id: number; name: string; status: string};
export class CopilotRunnerConnection implements CopilotSession {
  models: CopilotModel[] = [];
  model = '';
  private credential?: CopilotCredential;
  private keys?: Awaited<ReturnType<typeof loginKeys>>;
  private pipeline = 0;
  private project = '';
  private generation = 0;
  private abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private onExpired?: () => void;
  constructor(private client: GitLabClient, private clientId: string, private fetcher: typeof fetch = fetch) {}
  get connected() { return !!this.credential && this.credential.expires > Date.now() && !!this.models.length; }
  onDisconnect(callback: () => void) { this.onExpired = callback; }
  private get path() { return `/projects/${encodeURIComponent(this.client.config.project)}`; }
  private check(generation: number) { if (generation !== this.generation || this.abort.signal.aborted) throw new Error('Anmeldung abgebrochen.'); }
  private async jobs() { return (await this.client.api<Job[]>(`${this.path}/pipelines/${this.pipeline}/jobs?per_page=100`, { signal: this.abort.signal })).data; }
  async start(): Promise<CopilotLogin> {
    this.disconnect(); this.abort = new AbortController(); const generation = this.generation;
    try {
      this.keys = await loginKeys(); this.check(generation);
      const { data: project } = await this.client.api<{id: number; default_branch: string}>(this.path, { signal: this.abort.signal });
      this.check(generation); this.project = String(project.id);
      const response = await this.client.api<{id: number}>(`${this.path}/pipeline`, { method: 'POST', signal: this.abort.signal, body: JSON.stringify({ ref: project.default_branch, variables: [
        { key: 'HOOSPEC_COPILOT_LOGIN', value: '1' }, { key: 'HOOSPEC_COPILOT_CLIENT_ID', value: this.clientId },
        { key: 'HOOSPEC_COPILOT_PUBLIC_KEY', value: this.keys.publicKey }, { key: 'HOOSPEC_COPILOT_NONCE', value: this.keys.nonce },
      ] }) });
      // A create request can finish after cancellation; cancel the resulting pipeline too.
      if (generation !== this.generation) { void this.cancelPipeline(response.data.id); throw new Error('Anmeldung abgebrochen.'); }
      this.pipeline = response.data.id;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        this.check(generation);
        const job = (await this.jobs()).find(item => item.name === 'hoospec-copilot-login');
        if (job) {
          if (['failed', 'canceled', 'skipped'].includes(job.status)) throw new Error('Copilot-Login-Job fehlgeschlagen. OAuth-App, Runner und GitLab-CI-Konfiguration prüfen.');
          if (['running', 'success'].includes(job.status)) {
            const trace = await (await this.client.raw(`${this.path}/jobs/${job.id}/trace`, { signal: this.abort.signal })).text();
            const marker = trace.match(/HOOSPEC_COPILOT_LOGIN (\{[^\r\n]+\})/);
            if (marker) {
              const login = JSON.parse(marker[1]); this.check(generation);
              if (login.nonce !== this.keys!.nonce || login.verificationUrl !== 'https://github.com/login/device' || !/^[A-Z0-9-]{4,30}$/.test(login.userCode || '') || !Number.isFinite(login.expiresIn) || login.expiresIn <= 0 || login.expiresIn > 900) throw new Error('Ungültiger GitHub-Anmeldecode.');
              return { ...login, interval: 5 };
            }
          }
        }
        await new Promise<void>((resolve, reject) => {
          const signal = this.abort.signal;
          const stop = () => { clearTimeout(timer); reject(new Error('Anmeldung abgebrochen.')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, 3000);
          signal.addEventListener('abort', stop, { once: true });
        });
      }
      throw new Error('Der Runner startet nicht. Verfügbare Runner und den Job hoospec-copilot-login prüfen.');
    } catch (error) {
      this.disconnect();
      if (error instanceof GitLabError && [400, 403].includes(error.status)) throw new Error('GitLab erlaubt den Login-Job nicht. Developer-Rechte, Workflow-Regeln und die Mindestrolle für Pipeline-Variablen prüfen.');
      throw error;
    }
  }
  async poll() {
    const generation = this.generation;
    const job = (await this.jobs()).find(item => item.name === 'hoospec-copilot-login'); this.check(generation);
    if (!job) throw new Error('Der Copilot-Login-Job fehlt. CI-Include prüfen.');
    if (['failed', 'canceled', 'skipped'].includes(job.status)) throw new Error('GitHub-Anmeldung fehlgeschlagen oder abgebrochen. Eigene OAuth-App und Copilot-Berechtigung prüfen.');
    if (job.status !== 'success') return { connected: false, interval: 5 };
    const response = await this.client.raw(`${this.path}/jobs/${job.id}/artifacts/.hoospec-copilot/login.json`, { signal: this.abort.signal });
    const serialized = await response.text();
    if (serialized.length > 30000) throw new Error('Ungültiges Anmeldeartefakt.');
    const envelope = JSON.parse(serialized); this.check(generation);
    const credential = await openCredential(envelope, this.keys!.privateKey, { nonce: this.keys!.nonce, pipeline: String(this.pipeline), project: this.project }); this.check(generation);
    this.credential = credential;
    const modelsResponse = await this.api('/models');
    if (!modelsResponse.ok) throw new Error('Copilot gibt für dieses Konto keine Modelle frei. App-Berechtigung und Abo prüfen.');
    const modelText = await modelsResponse.text();
    if (modelText.length > 1000000) throw new Error('Copilot-Modellliste zu groß.');
    const data = JSON.parse(modelText); this.check(generation);
    this.models = (Array.isArray(data.data) ? data.data : []).filter((item: {id?: string; capabilities?: {type?: string; limits?: {max_output_tokens?: number}}; supported_endpoints?: string[]; model_picker_enabled?: boolean}) => typeof item.id === 'string' && item.model_picker_enabled !== false && item.capabilities?.type === 'chat' && (!item.supported_endpoints || item.supported_endpoints.includes('/chat/completions'))).map((item: {id: string; name?: string}) => ({ id: item.id, name: item.name || item.id }));
    if (!this.models.length) throw new Error('Keine kompatiblen Copilot-Chatmodelle verfügbar.');
    this.model = this.models.find(item => /gpt-4.1|gpt-5-mini/.test(item.id))?.id || this.models[0].id;
    this.keys = undefined;
    this.timer = setTimeout(() => this.disconnect(), Math.max(1, credential.expires - Date.now()));
    // Erase encrypted artifacts and the login code; credentials remain only in this tab.
    void this.client.raw(`${this.path}/jobs/${job.id}/erase`, { method: 'POST' }).catch(() => {});
    return { connected: true, interval: 5 };
  }
  private api(path: string, init?: RequestInit) {
    if (!this.credential || this.credential.expires <= Date.now()) { this.disconnect(); throw new Error('Copilot-Anmeldung abgelaufen. Bitte erneut verbinden.'); }
    return this.fetcher.call(globalThis, copilotEndpoint(this.credential.endpoint) + path, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(150000), ...(init?.signal ? [init.signal] : [])]), headers: { Authorization: `Bearer ${this.credential.token}`, Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json', 'X-Initiator': 'user' } : {}) } }).catch(error => { if (!init?.signal?.aborted && !this.abort.signal.aborted) this.disconnect(); throw error; });
  }
  async agent(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (!this.connected) return Response.json({ error: 'Bitte erneut mit Copilot verbinden.' }, { status: 401 });
    const file = { source: String(body.source), filename: String(body.filename) };
    const node = flattenNodes(parseDocument(file.source, file.filename)).find(item => item.id === body.nodeId);
    const model = body.model === undefined ? this.model : body.model;
    if (!node || !this.models.some(item => item.id === model)) throw new Error('Ungültige Auswahl oder Copilot-Modell.');
    const response = await this.api('/chat/completions', { method: 'POST', signal, body: JSON.stringify({ model, stream: true, messages: agentMessages(file, node, String(body.instruction)) }) });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) this.disconnect();
      return Response.json({ error: `Copilot konnte die Änderung nicht ausführen (HTTP ${response.status}).${response.status === 401 ? ' Bitte erneut verbinden.' : ''}` }, {status: response.status});
    }
    if (!response.body) throw new Error('Copilot hat keinen Antwortstrom geliefert.');
    const reader = response.body.getReader(), decoder = new TextDecoder(), frames = new EventStreamDecoder(), encoder = new TextEncoder();
    const aborted = () => { void reader.cancel().catch(() => {}); };
    const signals = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    return new Response(new ReadableStream({ start: async controller => {
      let replacement = '', completed = false;
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      signals.addEventListener('abort', aborted, { once: true });
      try {
        send('status', { message: 'Copilot formuliert die Änderung …' });
        while (true) {
          signals.throwIfAborted(); const { value, done } = await reader.read();
          for (const frame of frames.push(done ? decoder.decode() : decoder.decode(value, {stream: true}), done)) {
            if (frame.data === '[DONE]') { completed = true; continue; }
            const data = JSON.parse(frame.data), choice = data.choices?.[0];
            if (data.error || (choice?.finish_reason && choice.finish_reason !== 'stop')) throw new Error('Copilot hat die Antwort nicht vollständig ausgeführt.');
            if (typeof choice?.delta?.content === 'string') { replacement += choice.delta.content; if (replacement.length > 200000) throw new Error('Copilot-Antwort zu groß.'); send('delta', { text: choice.delta.content }); }
            if (choice?.finish_reason === 'stop') completed = true;
          }
          if (done) break;
        }
        signals.throwIfAborted();
        if (!completed || !replacement.trim()) throw new Error('Unvollständige Copilot-Antwort. Bitte erneut versuchen.');
        replacement = alignAgentIndent(sourceOf(file.source, node), normalizeAgentSource(replacement, documentKind(file.filename) === 'adr' ? 'markdown' : 'gherkin'));
        send('complete', { replacement });
      } catch { try { send('error', { message: 'Copilot-Antwort abgebrochen oder ungültig. Keine Änderung gespeichert.' }); } catch { /* Consumer cancelled. */ } }
      finally { signals.removeEventListener('abort', aborted); reader.releaseLock(); try { controller.close(); } catch { /* Consumer cancelled. */ } }
    }, cancel: () => { void reader.cancel().catch(() => {}); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  private cancelPipeline(id: number) { return this.client.raw(`${this.path}/pipelines/${id}/cancel`, {method: 'POST'}).catch(() => {}); }
  disconnect() {
    this.generation++; this.abort.abort(); clearTimeout(this.timer); this.keys = undefined;
    if (this.credential) this.credential.token = ''; this.credential = undefined; this.models = []; this.model = '';
    const pipeline = this.pipeline; this.pipeline = 0; if (pipeline) void this.cancelPipeline(pipeline);
    this.onExpired?.();
  }
}
