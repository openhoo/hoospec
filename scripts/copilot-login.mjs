import { webcrypto } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const hosts = ['api.githubcopilot.com', 'api.individual.githubcopilot.com', 'api.business.githubcopilot.com'];
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Copilot endpoint rejected');
  return url.origin;
}
/** @returns {Promise<{version: 1, key: string, iv: string, ciphertext: string}>} */
export async function sealCredential(data, publicKey) {
  const key = await webcrypto.subtle.importKey('spki', Buffer.from(publicKey, 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`${data.project}:${data.pipeline}:${data.nonce}`);
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aes, new TextEncoder().encode(JSON.stringify(data)));
  const wrapped = await webcrypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, await webcrypto.subtle.exportKey('raw', aes));
  return { version: 1, key: Buffer.from(wrapped).toString('base64'), iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') };
}
export async function runLogin(env, { fetcher = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, challenge = data => console.log('HOOSPEC_COPILOT_LOGIN ' + JSON.stringify(data)), output = async data => { await mkdir('.hoospec-copilot', { recursive: true }); await writeFile('.hoospec-copilot/login.json', JSON.stringify(data), { mode: 0o600 }); } } = {}) {
  if (env.CI_PIPELINE_SOURCE !== 'api' || env.CI_COMMIT_BRANCH !== env.CI_DEFAULT_BRANCH || env.HOOSPEC_COPILOT_LOGIN !== '1' || env.CI_DEBUG_TRACE === 'true' || env.CI_DEBUG_SERVICES === 'true') throw new Error('Use an API login pipeline on the default branch without debug tracing');
  const clientId = env.HOOSPEC_COPILOT_CLIENT_ID, publicKey = env.HOOSPEC_COPILOT_PUBLIC_KEY, nonce = env.HOOSPEC_COPILOT_NONCE;
  if (!/^[A-Za-z0-9_.-]{5,120}$/.test(clientId || '') || !/^[A-Za-z0-9+/=]{300,1000}$/.test(publicKey || '') || !/^[A-Za-z0-9+/]{43}=$/.test(nonce || '') || !/^\d+$/.test(env.CI_PIPELINE_ID || '') || !/^\d+$/.test(env.CI_PROJECT_ID || '')) throw new Error('Invalid public login parameters');
  // Validate the browser key before asking GitHub for any credential.
  await webcrypto.subtle.importKey('spki', Buffer.from(publicKey, 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  async function request(url, init) {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('GitHub/Copilot refused the login; check the app and subscription');
    return response.json();
  }
  const oauth = (path, body) => request('https://github.com/login/' + path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const device = await oauth('device/code', { client_id: clientId, scope: 'read:user' });
  if (typeof device.device_code !== 'string' || !/^[A-Z0-9-]{4,30}$/.test(device.user_code || '') || !Number.isFinite(device.expires_in) || device.expires_in <= 0) throw new Error('Enable Device Flow in your own OAuth app');
  const expiresIn = Math.min(device.expires_in, 900), deadline = now() + expiresIn * 1000;
  let interval = Math.max(5, Math.min(60, Number(device.interval) || 5));
  challenge({ nonce, userCode: device.user_code, verificationUrl: 'https://github.com/login/device', interval, expiresIn });
  while (now() < deadline) {
    await sleep(interval * 1000);
    if (now() >= deadline) break;
    const result = await oauth('oauth/access_token', { client_id: clientId, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') { interval += 5; continue; }
    if (result.error || typeof result.access_token !== 'string' || !/^(gho_|ghu_)/.test(result.access_token)) throw new Error('GitHub login denied or expired');
    // The direct Copilot API uses a short-lived API token. Never artifact the OAuth token.
    const api = await request('https://api.github.com/copilot_internal/v2/token', { headers: { Authorization: `Bearer ${result.access_token}`, Accept: 'application/json' } });
    result.access_token = '';
    if (typeof api.token !== 'string' || !api.token || !Number.isFinite(api.expires_at)) throw new Error('No Copilot API access for this account/app');
    const expires = Math.min(api.expires_at * 1000, now() + 3600000);
    if (expires <= now() + 30000) throw new Error('Copilot credential expired');
    const data = { token: api.token, endpoint: endpoint(api.endpoints?.api || 'https://api.githubcopilot.com'), expires, nonce, pipeline: env.CI_PIPELINE_ID, project: env.CI_PROJECT_ID };
    const envelope = await sealCredential(data, publicKey); data.token = ''; api.token = '';
    await output(envelope); return;
  }
  throw new Error('GitHub login expired');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLogin(process.env).catch(() => { console.error('Copilot login failed. Check OAuth Device Flow, subscription and runner network access, then retry.'); process.exitCode = 1; });
}
