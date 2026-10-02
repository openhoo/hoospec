import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeGitLabConfig } from '../src/lib/gitlab-client.ts';

function fields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: JSON-Objekt erwartet.`);
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.includes(key)) throw new Error(`${label}: unbekanntes Feld ${key}. Zugangsdaten gehören nicht in die öffentliche Konfiguration.`);
    if (typeof item !== 'string' || item.length > 1024) throw new Error(`${label}.${key}: kurzer Text erwartet.`);
  }
}
export function resolvePagesConfig(input = {}, env = {}) {
  for (const key of Object.keys(input)) if (!['$schema', 'schemaVersion', 'gitlab', 'agent', 'paths'].includes(key)) throw new Error(`Unbekanntes Konfigurationsfeld ${key}.`);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error('Unbekannte Hoospec-Konfigurationsversion.');
  const gitlab = input.gitlab || {}, agent = input.agent || {}, paths = input.paths || {};
  fields(paths, ['specs', 'adrs', 'workspace'], 'paths');
  for (const [key, legacy] of [['specs', 'specDirectory'], ['adrs', 'adrDirectory'], ['workspace', 'directory']]) {
    if (paths[key] !== undefined && gitlab[legacy] !== undefined && paths[key] !== gitlab[legacy]) throw new Error(`paths.${key} und gitlab.${legacy} widersprechen sich. Bitte nur paths.${key} verwenden.`);
  }
  fields(gitlab, ['instance', 'project', 'branch', 'clientId', 'directory', 'specDirectory', 'adrDirectory'], 'gitlab');
  fields(agent, ['url'], 'agent');
  const project = env.NEXT_PUBLIC_GITLAB_PROJECT || gitlab.project || env.CI_PROJECT_PATH || '';
  const normalized = normalizeGitLabConfig({
    instance: env.NEXT_PUBLIC_GITLAB_URL || gitlab.instance || env.CI_SERVER_URL || 'https://gitlab.com',
    project: project || 'setup/required', branch: env.NEXT_PUBLIC_GITLAB_BRANCH || gitlab.branch || env.CI_DEFAULT_BRANCH || 'main',
    clientId: env.NEXT_PUBLIC_GITLAB_CLIENT_ID || gitlab.clientId || '', directory: paths.workspace ?? gitlab.directory ?? 'hoospec',
    specDirectory: paths.specs ?? gitlab.specDirectory ?? '', adrDirectory: paths.adrs ?? gitlab.adrDirectory ?? 'docs/adr',
    agentUrl: env.NEXT_PUBLIC_HOOSPEC_AGENT_URL || agent.url || '', requireMembership: true,
  });
  return { ...normalized, project: project ? normalized.project : '' };
}
export async function readPagesConfig(root, env = process.env) {
  let input = {};
  const locations = [...new Set([...(env.CI_PROJECT_DIR ? [path.join(env.CI_PROJECT_DIR, 'hoospec.config.json')] : []), path.join(root, 'hoospec.config.json')])];
  for (const location of locations) {
    try { input = JSON.parse(await readFile(location, 'utf8')); break; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('hoospec.config.json ist ungültig. Bitte Syntax und öffentliche Felder prüfen.'); }
  }
  return resolvePagesConfig(input, env);
}
export function pagesPath(value = '') {
  if (value && (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(value) || value.length > 120)) throw new Error('HOOSPEC_PAGES_PATH muss ein relativer Pfad wie hoospec sein.');
  return value;
}
