import { spawn } from 'node:child_process';

// Use your secret manager's pipe or a server-only environment variable.
let key = process.env.HOOSPEC_AI_KEY || '';
if (!key && !process.stdin.isTTY) for await (const chunk of process.stdin) key += chunk;
key = key.trim();
if (!key) { console.error('HooLLM-Zugang fehlt.'); process.exit(1); }
const mode = process.argv[2] || 'catalog';
const base = (process.env.HOOSPEC_AI_BASE_URL || 'https://ai.openhoo.ai/v1').replace(/\/$/, '');
if (mode === 'catalog') {
  try {
    const response = await fetch(`${base}/models`, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'Hoospec/0.1' } });
    if (!response.ok) { console.error(`HooLLM-Katalog: HTTP ${response.status}`); process.exit(1); }
    const body = await response.json();
    console.log(JSON.stringify({ models: body.data.map(item => item.id) }, null, 2));
  } catch { console.error('HooLLM-Katalog konnte nicht gelesen werden.'); process.exit(1); }
} else if (mode === 'dev' || mode === 'start') {
  const model = process.argv[3] || process.env.HOOSPEC_AI_MODEL;
  if (!model) { console.error('Bitte den gewählten HooLLM-Modellnamen angeben.'); process.exit(1); }
  const port = process.env.HOOSPEC_PORT || '3410';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) { console.error('Ungültiger Studio-Port.'); process.exit(1); }
  const args = mode === 'start' ? ['scripts/start.mjs'] : ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', port];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, HOOSPEC_AI_KEY: key, HOOSPEC_AI_MODEL: model, HOOSPEC_AI_BASE_URL: base, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  key = '';
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', code => process.exit(code || 0));
} else { console.error('Unbekannter Modus.'); process.exit(1); }
