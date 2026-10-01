import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve('out');
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    result.push(...(entry.isDirectory() ? await files(filename) : [filename]));
  }
  return result;
}
const exported = await files(root), html = await readFile(path.join(root, 'index.html'), 'utf8');
assert.ok(html.includes('hoospec'));
assert.match(await readFile(path.join(root, 'LICENSE'), 'utf8'), /Apache License/);
await readFile(path.join(root, 'NOTICE'));
await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'));
assert.ok(!exported.some(file => /(?:^|\/)(?:api|\.env[^/]*|workspace\.json|server\.js)(?:\/|$)/.test(path.relative(root, file))));
const expected = process.env.NEXT_PUBLIC_BASE_PATH ?? ((process.env.CI_PAGES_URL ? new URL(process.env.CI_PAGES_URL).pathname.replace(/\/$/, '') : '') + (process.env.HOOSPEC_PAGES_PATH ? '/' + process.env.HOOSPEC_PAGES_PATH : ''));
for (const asset of [...html.matchAll(/(?:src|href)="([^" ]*\/_next\/[^" ]+)"/g)].map(match => match[1])) {
  assert.ok(asset.startsWith(expected + '/_next/'), `Unexpected asset path: ${asset}`);
  await readFile(path.join(root, asset.slice(expected.length).split('?')[0]));
}
assert.ok(exported.some(file => file.endsWith('.js')));
const privateMarkers = [process.env.HOOSPEC_AI_KEY, process.env.HOOSPEC_REPOSITORY_AGENT_TOKEN].filter(value => value && value.length >= 16);
for (const file of exported) {
  if (!/\.(?:js|html|json|txt)$/.test(file)) continue;
  const content = await readFile(file, 'utf8');
  assert.ok(!privateMarkers.some(marker => content.includes(marker)), 'A server credential was included in the static export.');
}
console.log('✓ Static Pages export contains deployable assets at the expected base path and no API handlers or workspace files.');
