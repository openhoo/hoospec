import test from 'node:test';
import { CopilotClient } from '@github/copilot-sdk';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { copilotSessionConfig } from '../src/lib/copilot-runtime';

test('bundled Copilot runtime accepts the real editor session configuration without login or inference', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hoospec-sdk-test-'));
  const client = new CopilotClient({ mode: 'empty', baseDirectory: directory, workingDirectory: directory, useLoggedInUser: false, env: { PATH: process.env.PATH, HOME: directory }, logLevel: 'none' });
  try {
    await client.start();
    // BYOK avoids external authentication. No message is sent; the unreachable
    // fixture endpoint proves this checks runtime configuration, not inference.
    const session = await client.createSession({ ...copilotSessionConfig('fixture', [{ role: 'system', content: 'Editor fixture' }]), provider: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'synthetic-fixture' } });
    await session.disconnect();
  } finally { await client.stop(); await rm(directory, {recursive: true, force: true}); }
});
