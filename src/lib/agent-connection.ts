import { ApiError } from './errors';
import type { AIModel } from './types';
export type AgentConnection = { aiReady: boolean; aiModels: AIModel[]; aiModel: string; model: string };
const empty = (): AgentConnection => ({ aiReady: false, aiModels: [], aiModel: '', model: '' });
let epoch = 0;
let cached = empty(), until = 0, signature = '', pending: Promise<AgentConnection> | undefined;
/** A successful authenticated catalog request establishes readiness; config alone never does. */
export function agentConnection(): Promise<AgentConnection> {
  const key = process.env.HOOSPEC_AI_KEY, model = process.env.HOOSPEC_AI_MODEL;
  const base = (process.env.HOOSPEC_AI_BASE_URL || 'https://ai.openhoo.ai/v1').replace(/\/$/, '');
  const allowed = process.env.HOOSPEC_AI_MODELS || '';
  const next = JSON.stringify([key, model, base, allowed]);
  if (!key || !model) return Promise.resolve(empty());
  if (signature === next && pending) return pending;
  if (signature === next && Date.now() < until) return Promise.resolve(cached);
  signature = next; const started = epoch;
  const operation = (async () => {
    let result = empty();
    try {
      const response = await fetch(base + '/models', { headers: { Authorization: `Bearer ${key}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const text = await response.text(); if (text.length > 2000000) throw new Error();
        const data = JSON.parse(text), allow = allowed.split(',').map(id => id.trim()).filter(Boolean);
        const models: AIModel[] = [];
        for (const item of Array.isArray(data.data) ? data.data : []) {
          if (typeof item.id !== 'string' || !item.id || item.id.length > 200 || models.some(entry => entry.id === item.id) || (allow.length && !allow.includes(item.id)) || (item.capabilities?.type && item.capabilities.type !== 'chat')) continue;
          models.push({ id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 200) : item.id });
          if (models.length >= 200) break;
        }
        if (models.length) { const chosen = models.find(item => item.id === model)?.id || models[0].id; result = { aiReady: true, aiModels: models, aiModel: chosen, model: chosen }; }
      }
    } catch { /* Fail closed; never return provider bodies or credentials. */ }
    if (signature === next && epoch === started) { cached = result; until = Date.now() + (result.aiReady ? 15000 : 5000); }
    return epoch === started ? result : empty();
  })();
  pending = operation;
  void operation.finally(() => { if (pending === operation) pending = undefined; });
  return operation;
}
export function invalidateAgentConnection() { epoch++; cached = empty(); until = Date.now() + 5000; }
export async function agentModel(value?: unknown) {
  const connection = await agentConnection();
  if (!connection.aiReady) throw new ApiError('Der AI-Dienst ist nicht verbunden. Bitte Verbindung und Zugang prüfen.', 503);
  const model = value === undefined ? connection.aiModel : value;
  if (typeof model !== 'string' || !connection.aiModels.some(item => item.id === model)) throw new ApiError('Dieses AI-Modell ist nicht verfügbar.', 400);
  return model;
}
