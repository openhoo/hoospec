import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readPagesConfig, pagesPath } from './pages-config.mjs';
const root = process.cwd();
const settings = await readPagesConfig(root);
const nestedPath = pagesPath(process.env.HOOSPEC_PAGES_PATH || '');
const staged = await mkdtemp(path.join(root, '.pages-build-'));
try {
  for (const file of ['src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs', 'components.json']) await cp(path.join(root, file), path.join(staged, file), { recursive: true });
  // Dynamic API handlers remain in the server build, never in the static artifact.
  await rm(path.join(staged, 'src/app/api'), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(staged, 'node_modules'), 'dir');
  const pagesUrl = process.env.CI_PAGES_URL;
  const pagesBase = pagesUrl ? new URL(pagesUrl).pathname.replace(/\/$/, '') : '';
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? (pagesBase + (nestedPath ? '/' + nestedPath : ''));
  await writeFile(path.join(staged, 'src/lib/pages-settings.ts'), `import type { GitLabConfig } from './gitlab-client';\nexport const pagesSettings: GitLabConfig = ${JSON.stringify(settings)};\n`);
  if (basePath && (!basePath.startsWith('/') || /[?#]/.test(basePath))) throw new Error('NEXT_PUBLIC_BASE_PATH muss ein URL-Pfad sein.');
  const env = { ...process.env, NEXT_PUBLIC_HOOSPEC_PAGES: 'true', NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_GITLAB_URL: process.env.NEXT_PUBLIC_GITLAB_URL || process.env.CI_SERVER_URL || 'https://gitlab.com', NEXT_PUBLIC_GITLAB_PROJECT: process.env.NEXT_PUBLIC_GITLAB_PROJECT || process.env.CI_PROJECT_PATH || '', NEXT_PUBLIC_GITLAB_BRANCH: process.env.NEXT_PUBLIC_GITLAB_BRANCH || process.env.CI_DEFAULT_BRANCH || 'main', NEXT_PUBLIC_GITLAB_CLIENT_ID: process.env.NEXT_PUBLIC_GITLAB_CLIENT_ID || '', NEXT_PUBLIC_HOOSPEC_AGENT_URL: process.env.NEXT_PUBLIC_HOOSPEC_AGENT_URL || '', NEXT_TELEMETRY_DISABLED: '1' };
  const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { cwd: staged, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error(`Pages-Build fehlgeschlagen (${code}).`);
  await mkdir(path.join(root, 'out'), { recursive: true });
  await rm(path.join(root, 'out'), { recursive: true, force: true });
  await cp(path.join(staged, 'out'), path.join(root, 'out'), { recursive: true });
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, name), path.join(root, 'out', name));
  console.log(`GitLab Pages: out/ erstellt (Base Path: ${basePath || '/'}).`);
} finally { await rm(staged, { recursive: true, force: true }); }
