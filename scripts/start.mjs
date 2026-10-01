import { access, cp } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const server = path.join(root, '.next/standalone/server.js');
try { await access(server); } catch { throw new Error('Bitte vor dem Start npm run build ausführen.'); }
const port = process.env.HOOSPEC_PORT || process.env.PORT || '3410';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Ungültiger Studio-Port.');
await cp(path.join(root, 'public'), path.join(root, '.next/standalone/public'), { recursive: true });
await cp(path.join(root, '.next/static'), path.join(root, '.next/standalone/.next/static'), { recursive: true });
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, name), path.join(root, '.next/standalone', name));
const child = spawn(process.execPath, [server], {
  cwd: root,
  env: { ...process.env, PORT: port, HOSTNAME: process.env.HOOSPEC_HOST || '127.0.0.1', HOOSPEC_DATA_DIR: path.resolve(process.env.HOOSPEC_DATA_DIR || path.join(root, '.hoospec')), NEXT_TELEMETRY_DISABLED: '1' },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('Studio konnte nicht gestartet werden.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
