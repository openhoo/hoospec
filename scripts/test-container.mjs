import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile), image = process.argv[2] || 'hoospec:test';
const name = 'hoospec-smoke-' + randomUUID(), volume = name + '-data';
const docker = async (...args) => (await run('docker', args)).stdout.trim();
try {
  await docker('volume', 'create', volume);
  await docker('run', '--detach', '--name', name, '--publish', '127.0.0.1::3000', '--volume', `${volume}:/data/hoospec`, image);
  const container = JSON.parse(await docker('inspect', name))[0];
  assert.equal(container.Config.User, 'node');
  await docker('exec', name, 'node', '--input-type=module', '-e', `
    import { CopilotClient } from '@github/copilot-sdk';
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    const directory = await mkdtemp(path.join(tmpdir(), 'hoospec-runtime-'));
    const client = new CopilotClient({ mode: 'empty', baseDirectory: directory, workingDirectory: directory, useLoggedInUser: false, env: { PATH: process.env.PATH, HOME: directory }, logLevel: 'none' });
    try { await client.start(); await client.ping('Container runtime check'); }
    finally { await client.stop(); await rm(directory, {recursive: true, force: true}); }
  `);
  let base;
  async function ready() {
    // Docker may allocate a different ephemeral host port on restart.
    const running = JSON.parse(await docker('inspect', name))[0];
    base = 'http://127.0.0.1:' + running.NetworkSettings.Ports['3000/tcp'][0].HostPort;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* Starting. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('Container did not become ready.');
  }
  await ready();
  const html = await (await fetch(base)).text();
  const assets = [...html.matchAll(/(?:src|href)="([^" ]*\/_next\/[^" ]+)"/g)].map(match => match[1].replaceAll('&amp;', '&'));
  assert.ok(assets.length > 0);
  for (const asset of assets) assert.equal((await fetch(new URL(asset, base))).status, 200);
  const state = await (await fetch(base + '/api/workspace')).json(), file = state.files[0];
  const source = file.source + '\n# Container persistence smoke test\n';
  const save = await fetch(base + '/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ action: 'save', fileId: file.id, version: file.version, source, actor: 'Container smoke test' }) });
  assert.equal(save.status, 200);
  const disk = JSON.parse(await docker('exec', name, 'cat', '/data/hoospec/workspace.json'));
  assert.equal(disk.schemaVersion, 2); assert.equal(Object.hasOwn(disk.files[0], 'source'), false);
  assert.equal((await fetch(base + '/api/workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.test' }, body: '{}' })).status, 403);
  await docker('restart', name); await ready();
  const restored = await (await fetch(base + '/api/workspace')).json();
  assert.equal(restored.files.find(item => item.id === file.id).source, source);
  console.log('✓ Non-root container serves assets, saves canonical JSON, rejects foreign writes and restores its volume after restart.');
} finally {
  await docker('rm', '--force', name).catch(() => {});
  await docker('volume', 'rm', volume).catch(() => {});
}
