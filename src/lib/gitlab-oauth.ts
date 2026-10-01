import { GitLabOAuthAccess } from './gitlab-auth';
import { normalizeGitLabConfig, type GitLabConfig } from './gitlab-client';
const pendingKey = 'hoospec-gitlab-oauth';
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function callbackUrl() { return location.origin + location.pathname; }
export async function beginGitLabLogin(config: GitLabConfig) {
  const normalized = normalizeGitLabConfig(config);
  if (!normalized.clientId.trim()) throw new Error('Bitte die öffentliche OAuth Application ID angeben.');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const redirect = callbackUrl();
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(pendingKey, JSON.stringify({ config: normalized, verifier, state, redirect, created: Date.now() }));
  const url = new URL(normalized.instance + '/oauth/authorize');
  url.search = new URLSearchParams({ client_id: normalized.clientId, redirect_uri: redirect, response_type: 'code', scope: 'api', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  location.assign(url.href);
}
export async function completeGitLabLogin(): Promise<{ config: GitLabConfig; access: GitLabOAuthAccess } | null> {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return null;
  const code = params.get('code'), state = params.get('state');
  // Remove authorization codes from the address and browser history immediately.
  history.replaceState(null, '', callbackUrl());
  const raw = sessionStorage.getItem(pendingKey); sessionStorage.removeItem(pendingKey);
  if (!raw) throw new Error('Die Anmeldung ist abgelaufen. Bitte erneut mit GitLab anmelden.');
  const pending = JSON.parse(raw);
  if (!state || pending.state !== state || !Number.isFinite(pending.created) || Date.now() - pending.created > 600000 || pending.created > Date.now() + 30000 || typeof pending.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(pending.verifier) || pending.redirect !== callbackUrl()) throw new Error('Die GitLab-Anmeldung konnte nicht sicher zugeordnet werden. Bitte erneut anmelden.');
  if (!code || params.has('error')) throw new Error('Die GitLab-Anmeldung wurde abgebrochen.');
  const config = normalizeGitLabConfig(pending.config);
  const response = await fetch(config.instance + '/oauth/token', { method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, code, redirect_uri: pending.redirect, code_verifier: pending.verifier }) });
  if (!response.ok) throw new Error('GitLab konnte die Anmeldung nicht abschließen. Bitte OAuth Application ID, öffentliche Anwendung und Redirect-URL prüfen.');
  const data = await response.json();
  if (typeof data.access_token !== 'string') throw new Error('GitLab hat keinen gültigen Zugang zurückgegeben.');
  return { config, access: new GitLabOAuthAccess(config.instance, config.clientId, data) };
}
