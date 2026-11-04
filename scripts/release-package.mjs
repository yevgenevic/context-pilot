import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiRequire = createRequire(new URL('../ui/package.json', import.meta.url));
const { buildSync } = uiRequire('esbuild');
const { version, engines } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const destination = path.join(root, 'site/download');
mkdirSync(destination, { recursive: true });
const work = mkdtempSync(path.join(destination, '.pack-'));

try {
  const stage = path.join(work, 'package');
  const cli = path.join(stage, 'bin/pilot.mjs');
  buildSync({
    entryPoints: [path.join(root, 'src/pilot.ts')],
    outfile: cli,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.18',
  });
  chmodSync(cli, 0o755);

  // The bundled server resolves ../ui relative to bin/pilot.mjs.
  for (const name of ['ui/dashboard.html', 'ui/dist/dashboard.js', 'ui/dist/dashboard.css',
    'README.md']) {
    const target = path.join(stage, name);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(root, name), target);
  }
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: 'context-pilot',
    version,
    private: true,
    description: 'Local project dashboard and context handoff for AI coding agents',
    type: 'module',
    bin: { pilot: './bin/pilot.mjs' },
    engines,
  }, null, 2) + '\n');

  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run npm run release:tgz from the project root.');
  const result = execFileSync(process.execPath, [npm, 'pack', '--json', '--offline', '--ignore-scripts',
    '--cache', path.join(work, 'cache'), '--pack-destination', work], { cwd: stage, encoding: 'utf8' });
  const [{ filename }] = JSON.parse(result);
  renameSync(path.join(work, filename), path.join(destination, filename));
  console.log('site/download/' + filename);
} finally {
  rmSync(work, { recursive: true, force: true });
}
