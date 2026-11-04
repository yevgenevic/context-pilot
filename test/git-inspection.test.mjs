import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/pilot.ts', import.meta.url));

test('reading a task and exporting a handoff do not run the repository fsmonitor hook', {
  skip: process.platform === 'win32',
}, t => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'pilot-git-read-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const run = (exe, args) => execFileSync(exe, args, { cwd, encoding: 'utf8' });
  const pilot = (...args) => run(process.execPath, [cli, ...args]);
  run('git', ['init', '-q']);
  writeFileSync(path.join(cwd, 'report.js'), '42\n');
  run('git', ['add', 'report.js']);
  pilot('init');
  pilot('task', 'CHECK', 'Check report', '--file', 'report.js');
  const hook = path.join(cwd, '.git', 'monitor');
  writeFileSync(hook, '#!/bin/sh\ntouch .monitor-executed\nexit 1\n', { mode: 0o700 });
  run('git', ['config', 'core.fsmonitor', hook]);
  assert.match(pilot('context', 'CHECK'), /report\.js/);
  assert.match(pilot('handoff', 'CHECK'), /report\.js/);
  assert.equal(existsSync(path.join(cwd, '.monitor-executed')), false);
});
