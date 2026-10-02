/** Only the tab that started login holds the private key. Never persist it. */
export type CopilotEnvelope = { version: 1; key: string; iv: string; ciphertext: string };
export type CopilotCredential = { token: string; endpoint: string; expires: number; nonce: string; pipeline: string; project: string };
export const copilotHosts = ['api.githubcopilot.com', 'api.individual.githubcopilot.com', 'api.business.githubcopilot.com'];
export function copilotEndpoint(input: string) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !copilotHosts.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Ungültiger Copilot-Endpunkt.');
  return url.origin;
}
export function encode64(value: ArrayBuffer | Uint8Array) { return btoa(String.fromCharCode(...new Uint8Array(value))); }
export function decode64(value: string) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)); }
export async function loginKeys() {
  const keys = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  return { privateKey: keys.privateKey, publicKey: encode64(await crypto.subtle.exportKey('spki', keys.publicKey)), nonce: encode64(crypto.getRandomValues(new Uint8Array(32))) };
}
export async function openCredential(envelope: CopilotEnvelope, privateKey: CryptoKey, expected: { nonce: string; pipeline: string; project: string }): Promise<CopilotCredential> {
  if (envelope.version !== 1 || ![envelope.key, envelope.iv, envelope.ciphertext].every(value => typeof value === 'string' && value.length < 20000)) throw new Error('Ungültiges Anmeldeartefakt.');
  const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, decode64(envelope.key));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const aad = new TextEncoder().encode(`${expected.project}:${expected.pipeline}:${expected.nonce}`);
  const text = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode64(envelope.iv), additionalData: aad }, key, decode64(envelope.ciphertext));
  const data = JSON.parse(new TextDecoder().decode(text));
  if (data.nonce !== expected.nonce || data.pipeline !== expected.pipeline || data.project !== expected.project || typeof data.token !== 'string' || !data.token || data.token.length > 12000 || !Number.isFinite(data.expires) || data.expires <= Date.now() || data.expires > Date.now() + 3600000) throw new Error('Die Anmeldung ist abgelaufen oder gehört zu einer anderen Sitzung.');
  copilotEndpoint(data.endpoint);
  return data;
}
