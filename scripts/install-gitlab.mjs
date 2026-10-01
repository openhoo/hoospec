import { cp, mkdir, access, lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
const target = process.argv[2];
if (!target) throw new Error('Aufruf: npm run install:gitlab -- /pfad/zum/bestehenden/projekt');
const projectRoot = path.resolve(target), destination = path.join(projectRoot, 'tools/hoospec');
await access(projectRoot);
try { await lstat(destination); throw new Error('tools/hoospec existiert bereits. Bestehende Dateien werden nicht überschrieben.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(destination), { recursive: true });
if ((await lstat(path.dirname(destination))).isSymbolicLink()) throw new Error('tools darf kein symbolischer Link sein.');
const files = ['src', 'public', 'scripts', 'tests', '.gitlab', '.gitignore', '.dockerignore', '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json', 'next.config.ts', 'postcss.config.mjs', 'components.json', 'eslint.config.mjs', 'README.md', 'AGENTS.md', 'Dockerfile', 'hoospec.config.json', 'hoospec.config.schema.json', 'docs', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md'];
const staging = await mkdtemp(path.join(path.dirname(destination), '.hoospec-install-'));
try {
  for (const name of files) await cp(path.join(import.meta.dirname, '..', name), path.join(staging, name), { recursive: true });
  await rename(staging, destination);
} finally { await rm(staging, { recursive: true, force: true }); }
console.log('Hoospec liegt unter tools/hoospec.');
console.log('1. Include tools/hoospec/.gitlab/integrate.yml in die bestehende .gitlab-ci.yml aufnehmen.');
console.log('2. hoospec-build zu den needs des Pages-Jobs ergänzen (bestehende Einträge behalten).');
console.log('3. Am Ende des bestehenden Pages-Builds: sh tools/hoospec/scripts/attach-pages.sh public');
console.log('4. GitLab Pages auf „Only project members“ stellen. OAuth-App für die fertige /hoospec/-URL registrieren.');
console.log('Anleitung: tools/hoospec/docs/gitlab.md');
