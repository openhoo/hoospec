'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { CopilotConnection, type CopilotLogin, type CopilotModel, type CopilotSession } from '@/lib/copilot-connection';
import type { GitLabBackend } from '@/lib/gitlab-backend';
import { Button } from './ui/button';
import { Input } from './ui/input';

export function CopilotConnect({ backend, url, onUrl, clientId, onClientId }: { backend: GitLabBackend; url: string; onUrl: (url: string) => void; clientId: string; onClientId: (value: string) => void }) {
  const [login, setLogin] = useState<CopilotLogin | null>(null);
  const [models, setModels] = useState<CopilotModel[]>(backend.copilotConnection?.connected ? backend.copilotConnection.models : []);
  const [model, setModel] = useState(backend.copilotConnection?.model || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const connection = useRef<CopilotSession | null>(backend.copilotConnection || null), generation = useRef(0), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { generation.current++; if (timer.current) clearTimeout(timer.current); if (!connection.current?.connected) connection.current?.disconnect(); }, []);
  useEffect(() => backend.subscribe({ snapshot: () => { if (!backend.copilotConnection?.connected) { setModels([]); setModel(''); } }, connection: () => {}, error: () => {} }), [backend]);
  function reset() {
    generation.current++; if (timer.current) clearTimeout(timer.current);
    connection.current?.disconnect(); connection.current = null; backend.configureCopilot(); setLogin(null); setModels([]); setModel(''); setBusy(false); setCopied(false);
  }
  async function start() {
    reset(); setError(''); setBusy(true); const current = generation.current;
    let next: CopilotSession;
    try {
      next = clientId.trim() ? backend.createCopilotLogin(clientId.trim()) : new CopilotConnection(url); connection.current = next;
      const challenge = await next.start(); if (current !== generation.current) return;
      setLogin(challenge); const expires = Date.now() + challenge.expiresIn * 1000;
      async function poll() {
        if (current !== generation.current) return;
        try {
          if (Date.now() >= expires) throw new Error('Der Code ist abgelaufen. Bitte erneut verbinden.');
          const result = await next.poll(); if (current !== generation.current) return;
          if (result.connected) { backend.configureCopilot(next); setModels(next.models); setModel(next.model); setLogin(null); setBusy(false); return; }
          timer.current = setTimeout(() => void poll(), result.interval * 1000);
        } catch (cause) { if (current === generation.current) { reset(); setError((cause as Error).message); } }
      }
      timer.current = setTimeout(() => void poll(), challenge.interval * 1000);
    } catch (cause) { if (current === generation.current) { reset(); setError((cause as Error).message); } }
  }
  return <section className="zen-copilot-connect" aria-label="Copilot-Verbindung">
    <div className="zen-copilot-heading"><strong>Copilot</strong><span>{models.length ? 'Verbunden' : 'Dein persönlicher AI-Zugang'}</span></div>
    {!models.length && <>
      <details><summary>Copilot konfigurieren</summary><label className="zen-repository-field"><span>GitHub OAuth-App-ID</span><Input aria-label="Copilot OAuth-App-ID" placeholder="Client-ID eurer eigenen GitHub OAuth App" value={clientId} onChange={event => onClientId(event.target.value)} disabled={busy}/></label>{!clientId && <><label className="zen-repository-field"><span>Copilot-Dienst</span><Input aria-label="Copilot-Dienst" placeholder="https://agent.example.com/api/copilot" value={url} onChange={event => onUrl(event.target.value)} disabled={busy}/></label></>}</details>
      {!login && <Button type="button" variant="outline" onClick={() => void start()} disabled={busy || (!clientId.trim() && !url.trim())}>{busy && <Loader2 size={15} className="animate-spin"/>}{busy ? 'Runner startet …' : 'Mit Copilot verbinden'}</Button>}{busy && !login && <button type="button" className="zen-disconnect" onClick={reset}>Abbrechen</button>}
      {login && <div className="zen-copilot-login"><p>Gib diesen Code bei GitHub ein.</p><div className="zen-redirect-copy"><code>{login.userCode}</code><button type="button" aria-label="Copilot-Code kopieren" onClick={async () => { try { await navigator.clipboard.writeText(login.userCode); setCopied(true); } catch { setError('Bitte den Code markieren und kopieren.'); } }}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button></div><a href={login.verificationUrl} target="_blank" rel="noopener noreferrer">GitHub öffnen <ExternalLink size={13}/></a><small role="status"><Loader2 size={12} className="animate-spin"/>Warte auf deine Freigabe …</small><button type="button" className="zen-disconnect" onClick={reset}>Abbrechen</button></div>}
      <small>Verwendet dein eigenes Copilot-Abo. Mit GitLab-Runner erfolgt die Anmeldung ohne zusätzlichen Server. Dokumentkontext wird direkt an Copilot gesendet.</small>
    </>}
    {!!models.length && <><label className="zen-repository-field"><span>Modell</span><select aria-label="Copilot-Modell" value={model} onChange={event => { const next = connection.current; if (next) { next.model = event.target.value; backend.configureCopilot(next); setModel(next.model); } }}>{models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button type="button" className="zen-disconnect" onClick={reset}>Copilot trennen</button></>}
    {error && <p role="alert" className="zen-dialog-error">{error}</p>}
  </section>;
}
