import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

function directory(logs: string, stage: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(stage)) throw Error('Некорректный ID этапа.');
  return path.join(path.dirname(logs), 'packets', stage);
}
export function packets(logs: string, stage: string) {
  const dir = directory(logs, stage);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^\d+\.md$/.test(name))
    .sort((a,b) => parseInt(a)-parseInt(b)).map(name => readFileSync(path.join(dir,name),'utf8'));
}
export function savePacket(logs: string, stage: string, attempt: number, prompt: string) {
  const dir = directory(logs, stage);
  mkdirSync(dir,{recursive:true,mode:0o700});
  const file = path.join(dir,attempt+'.md');
  writeFileSync(file+'.tmp',prompt,{mode:0o600});
  renameSync(file+'.tmp', file);
}
