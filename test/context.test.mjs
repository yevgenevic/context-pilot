import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../src/pilot.ts', import.meta.url));

test('tasks exports only IDs and text in lexicographic ID order', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'pilot-tasks-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  const pilot = (...args) => execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  pilot('init');
  assert.deepEqual(JSON.parse(pilot('tasks')), { schemaVersion: 1, tasks: [] });
  pilot('task', 'T2', 'Second', '--file', 'demo.txt');
  pilot('task', 'T10', 'Tenth');
  pilot('task', 'T', 'Prefix');
  assert.deepEqual(JSON.parse(pilot('tasks')), {
    schemaVersion: 1,
    tasks: [{ id: 'T', text: 'Prefix' }, { id: 'T10', text: 'Tenth' }, { id: 'T2', text: 'Second' }]
  });
});

test('a fresh clone restores only linked decisions and reports later edits', t => {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const original = join(dir, 'original'), fresh = join(dir, 'fresh');
  const run = (cmd, args, cwd = original) => execFileSync(cmd, args, {cwd, encoding:'utf8', stdio:'pipe'});
  const pilot = (...args) => run(process.execPath, [cli, ...args]);
  const commit = () => run('git', ['-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','snapshot']);
  run('git', ['init','-q',original], dir);
  writeFileSync(join(original, 'app.txt'), 'initial');
  run('git', ['add','.']); commit();
  pilot('init');
  pilot('rule','R1','Keep booking atomic','--file','app.txt');
  pilot('rule','R2','Unrelated rule');
  assert.throws(() => pilot('rule','R1','Overwrite'));
  assert.throws(() => pilot('task','T0','Bad task','--rule','MISSING'));
  pilot('task','T1','Add transfer','--rule','R1','--check','npm test');
  writeFileSync(join(original, 'app.txt'), 'manual change');
  run('git', ['add','.']); commit();
  run('git', ['clone','-q',original,fresh], dir);
  const packet = run(process.execPath, [cli,'context','T1'], fresh);
  assert.match(packet,/Keep booking atomic/);
  assert.doesNotMatch(packet,/Unrelated rule/);
  assert.match(packet,/после постановки задачи\n\napp.txt/);
  assert.match(packet,/npm test/);
});
