'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, ExternalLink, GitBranch, Loader2 } from 'lucide-react';
import { CopilotConnect } from './copilot-connect';
import { Studio } from './studio';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';
import { GitLabBackend } from '@/lib/gitlab-backend';
import { normalizeGitLabConfig, type GitLabConfig } from '@/lib/gitlab-client';
import { beginGitLabLogin, callbackUrl, completeGitLabLogin } from '@/lib/gitlab-oauth';
import { pagesSettings as defaults } from '@/lib/pages-settings';
import { useTheme } from '@/lib/theme';

const settingsKey = () => 'hoospec-gitlab-config:' + location.pathname;
function connectionConfig(input: GitLabConfig) {
  return normalizeGitLabConfig({ ...input, ...(defaults.project ? { instance: defaults.instance, project: defaults.project } : {}), requireMembership: true });
}
function remember(config: GitLabConfig) {
  try { localStorage.setItem(settingsKey(), JSON.stringify(config)); } catch { /* The login remains usable without local storage. */ }
}
export function RepositoryStudio() {
  useTheme();
  const [config, setConfig] = useState(defaults);
  const [token, setToken] = useState('');
  const [agentToken, setAgentToken] = useState('');
  const [backend, setBackend] = useState<GitLabBackend | null>(null);
  const [showConnection, setShowConnection] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [redirect, setRedirect] = useState('');
  const [setupOpen, setSetupOpen] = useState(!defaults.clientId.trim());
  const [copied, setCopied] = useState(false);
  const active = useRef<GitLabBackend | null>(null);
  const boot = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    if (!boot.current) {
      boot.current = true;
      const init = async () => {
        setRedirect(callbackUrl());
        // A corrupt old preference must not prevent consuming or clearing an OAuth callback.
        try { const saved = localStorage.getItem(settingsKey()); if (saved) { const remembered = connectionConfig({ ...defaults, ...JSON.parse(saved) }); setConfig(remembered); setSetupOpen(!remembered.clientId.trim()); } } catch { /* Use deployment defaults. */ }
        let next: GitLabBackend | undefined;
        try {
          const login = await completeGitLabLogin();
          if (login) {
            const normalized = connectionConfig(login.config);
            if (normalized.instance !== login.config.instance || normalized.project !== login.config.project) { login.access.disconnect(); throw new Error('Die Anmeldung gehört zu einem anderen Projekt. Bitte erneut anmelden.'); }
            setConfig(normalized); setSetupOpen(false); setBusy(true);
            next = new GitLabBackend(normalized, login.access);
            await next.load();
            if (!mounted.current) { next.disconnect(); return; }
            remember(normalized); active.current = next; setBackend(next); setShowConnection(false);
          }
        } catch (cause) { next?.disconnect(); if (mounted.current) setError((cause as Error).message); }
        finally { if (mounted.current) setBusy(false); }
      };
      void init();
    }
    return () => { mounted.current = false; active.current?.disconnect(); };
  }, []);
  const field = (name: keyof GitLabConfig, label: string, placeholder?: string) => <label className="zen-repository-field"><span>{label}</span><Input aria-label={label} value={String(config[name] || '')} placeholder={placeholder} onChange={event => setConfig(current => ({ ...current, [name]: event.target.value }))} disabled={busy}/></label>;
  async function login() {
    setBusy(true); setError('');
    try { const normalized = connectionConfig(config); remember(normalized); await beginGitLabLogin(normalized); }
    catch (cause) { setError((cause as Error).message); setBusy(false); }
  }
  async function connectToken() {
    setBusy(true); setError('');
    let next: GitLabBackend | undefined;
    try {
      const normalized = connectionConfig(config);
      next = new GitLabBackend(normalized, token, undefined, agentToken); await next.load();
      active.current?.disconnect(); active.current = next; remember(normalized);
      setBackend(next); setShowConnection(false); setToken(''); setAgentToken('');
    } catch (cause) { next?.disconnect(); setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  function downloadConfig() {
    try {
      const normalized = connectionConfig(config);
      const { instance, project, branch, clientId, directory, specDirectory, adrDirectory, agentUrl, copilotUrl, copilotClientId } = normalized;
      const data = { $schema: './hoospec.config.schema.json', schemaVersion: 1, gitlab: { instance, project, branch, clientId }, paths: { workspace: directory, specs: specDirectory, adrs: adrDirectory }, agent: { url: agentUrl || '' }, copilot: { clientId: copilotClientId || '', url: copilotUrl || '' } };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'hoospec.config.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError((cause as Error).message); }
  }
  let applicationUrl = '';
  try { applicationUrl = normalizeGitLabConfig({ ...config, project: config.project || 'setup/required' }).instance + '/-/user_settings/applications'; } catch { /* Show a link only for a valid destination. */ }
  const setup = !backend && setupOpen && <section className="zen-oauth-setup" aria-label="GitLab-Anmeldung einrichten">
    <h2>Einmal verbinden.</h2>
    <p>Registriere Hoospec als öffentliche OAuth-App in deinem GitLab-Profil. Du brauchst dafür normalerweise keine Instanz-Adminrechte.</p>
    <ol><li>{applicationUrl ? <a href={applicationUrl} target="_blank" rel="noopener noreferrer">OAuth-App in GitLab anlegen <ExternalLink size={13}/></a> : 'Eine gültige GitLab-Adresse angeben.'}<span>Name: Hoospec · Scope: api · Confidential deaktivieren</span></li><li><span>Diese Redirect-URL hinterlegen:</span><div className="zen-redirect-copy"><code>{redirect || 'Die URL wird geladen …'}</code><button type="button" aria-label="Redirect-URL kopieren" disabled={!redirect} onClick={async () => { try { await navigator.clipboard.writeText(redirect); setCopied(true); } catch { setError('Bitte die angezeigte Redirect-URL markieren und kopieren.'); } }}>{copied ? <Check size={15}/> : <Copy size={15}/>}</button></div></li><li>{field('clientId', 'Application ID', 'Öffentliche ID aus GitLab einfügen')}</li></ol>
    <small>Für das ganze Team: die ID in <code>hoospec.config.json</code> speichern und deployen. Die Pages-Sichtbarkeit im Projekt muss auf „Only project members“ stehen.</small>
  </section>;
  const content = <main className="zen-repository-connect"><GitBranch size={25} strokeWidth={1.4}/><h1>{backend ? 'Deine Verbindung.' : <>Specs und Entscheidungen.<br/>Direkt in eurem Projekt.</>}</h1><p>{backend ? 'GitLab verwaltet den Zugriff. Änderungen bleiben in eurem Repository.' : 'Ein ruhiger Ort für eure Reviews. Melde dich mit deinem GitLab-Konto an.'}</p>
    <form onSubmit={event => { event.preventDefault(); void login(); }}>
      {defaults.project ? <div className="zen-connected-project"><span>Projekt</span><strong>{defaults.project}</strong><small>{defaults.instance}</small></div> : <>{field('instance', 'GitLab-Adresse', 'https://gitlab.example.com')}{field('project', 'Projekt', 'gruppe/projekt oder Projekt-Link')}</>}
      {setup}
      <Button type="submit" disabled={busy || !config.clientId.trim() || !config.project.trim()}>{busy ? <Loader2 size={16} className="animate-spin"/> : <ArrowRight size={16}/>}Mit GitLab anmelden</Button>
      {backend && <CopilotConnect backend={backend} clientId={config.copilotClientId || ''} onClientId={copilotClientId => setConfig(current => ({ ...current, copilotClientId }))} url={config.copilotUrl || ''} onUrl={copilotUrl => setConfig(current => ({ ...current, copilotUrl }))}/>}
      <details className="zen-repository-options"><summary>Verbindungseinstellungen</summary>
        {field('branch', 'Branch')}{field('directory', 'Hoospec-Verzeichnis')}{field('specDirectory', 'Spec-Verzeichnis', 'Leer: alle .feature-Dateien')}{field('adrDirectory', 'ADR-Verzeichnis')}
        {(!setupOpen || backend) && field('clientId', 'OAuth Application ID')}
        <button className="zen-config-download" type="button" onClick={downloadConfig}>Öffentliche Konfiguration herunterladen</button>
        <small>Unter <code>tools/hoospec/hoospec.config.json</code> einchecken, damit alle dieselbe Verbindung verwenden. Enthält keine Zugangsdaten.</small>
        {field('agentUrl', 'Agent-Adresse', 'https://agent.example.com/api/repository-agent')}
        <label className="zen-repository-field"><span>Agent-Zugang</span><Input type="password" autoComplete="off" aria-label="Agent-Zugang" value={agentToken} onChange={event => setAgentToken(event.target.value)} disabled={busy}/><small>Optionaler separater AI-Dienst. Der HooLLM-Schlüssel bleibt auf seinem Server.</small></label>
        {backend && config.agentUrl && agentToken && <Button type="button" onClick={async () => { setBusy(true); try { await backend.configureAgent(config.agentUrl!, agentToken); setAgentToken(''); setShowConnection(false); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); } }} disabled={busy}>Agent verbinden</Button>}
        <details className="zen-token-alternative"><summary>Alternativ mit Token verbinden</summary><label className="zen-repository-field"><span>Zugriffstoken</span><Input type="password" autoComplete="off" aria-label="GitLab-Zugriffstoken" value={token} onChange={event => setToken(event.target.value)} disabled={busy}/><small>API-Scope und Projektmitgliedschaft erforderlich. Nur im Arbeitsspeicher dieser Sitzung.</small></label><Button type="button" disabled={busy || !token.trim()} onClick={() => void connectToken()}>Mit Token verbinden</Button></details>
      </details>
      {error && <p role="alert" className="zen-dialog-error">{error}</p>}
      {backend && <button type="button" className="zen-disconnect" onClick={() => { backend.disconnect(); active.current = null; setBackend(null); setToken(''); setAgentToken(''); }}>Verbindung trennen</button>}
    </form>
  </main>;
  return backend ? <><Studio key={backend.sessionId} backend={backend} suspended={showConnection} onRepository={() => setShowConnection(true)}/><Dialog open={showConnection} onOpenChange={open => { if (!busy) setShowConnection(open); }}><DialogContent className="zen-repository-dialog"><DialogTitle className="sr-only">Repository-Verbindung</DialogTitle><DialogDescription className="sr-only">GitLab-Verbindung und optionalen Agent einrichten.</DialogDescription>{content}</DialogContent></Dialog></> : <div className="zen-repository-shell"><header className="zen-repository-header"><strong className="zen-brand">hoospec<span>.</span></strong></header>{content}</div>;
}
