import { CopilotClient, type SessionConfig } from '@github/copilot-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError } from './errors';

export type CopilotModel = { id: string; name: string };
export interface CopilotRuntime {
  models(token: string): Promise<CopilotModel[]>;
  generate(token: string, model: string, messages: {role: string; content: string}[], delta: (text: string) => void, signal: AbortSignal): Promise<string>;
}
async function withClient<T>(token: string, work: (client: CopilotClient) => Promise<T>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hoospec-copilot-'));
  const client = new CopilotClient({ mode: 'empty', gitHubToken: token, useLoggedInUser: false, workingDirectory: directory, baseDirectory: directory, logLevel: 'none', env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory } });
  try { return await work(client); }
  catch { throw new ApiError('Copilot ist nicht verfügbar. Bitte Anmeldung, Copilot-Abo und Modellfreigabe prüfen.', 502); }
  finally { await client.stop().catch(() => {}); await rm(directory, { recursive: true, force: true }); }
}
export function copilotSessionConfig(model: string, messages: {role: string; content: string}[]): SessionConfig {
  return { model, availableTools: [], excludedTools: ['builtin:*', 'mcp:*', 'custom:*'], enableConfigDiscovery: false, streaming: true, systemMessage: { mode: 'replace', content: messages[0].content }, onPermissionRequest: () => ({ kind: 'reject' }) };
}
export const copilotRuntime: CopilotRuntime = {
  models: token => withClient(token, async client => (await client.listModels()).filter(model => model.policy?.state !== 'disabled').map(({ id, name }) => ({ id, name }))),
  generate: (token, model, messages, delta, signal) => withClient(token, async client => {
    signal.throwIfAborted();
    const session = await client.createSession(copilotSessionConfig(model, messages));
    const stop = () => { void client.stop().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    let length = 0;
    session.on('assistant.message_delta', event => { const text = event.data.deltaContent || ''; length += text.length; if (length > 200000) { stop(); return; } delta(text); });
    try {
      signal.throwIfAborted();
      const result = await session.sendAndWait({ prompt: messages[1].content }, 140000);
      signal.throwIfAborted();
      if (!result?.data.content || length > 200000) throw new Error('Incomplete response');
      return result.data.content;
    } finally { signal.removeEventListener('abort', stop); await session.disconnect().catch(() => {}); }
  }),
};
