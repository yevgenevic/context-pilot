import { readGit } from './git-read.ts';
import {redactSecrets} from './privacy.ts';
import {createHash} from 'node:crypto';
import {closeSync, constants, fstatSync, openSync, readSync, realpathSync} from 'node:fs';
import path from 'node:path';

const maxBytes = 32 * 1024;
const textFile = /\.(?:md|txt|js|jsx|mjs|cjs|ts|tsx|css|html|py|go|rs|java|rb|php|json|csv)$/i;
const sensitiveName = /(?:^|[\/._-])(?:secrets?|credentials?|tokens?|passwords?|private[-_]?key|auth|\.env)(?:[\/._-]|$)/i;
const sensitiveText = /-----BEGIN [\w ]*PRIVATE KEY-----|\bBearer\s+[\w.+/=\-]{12,}|\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|AKIA[A-Z0-9]{16})|(?:access[_-]?key|api[_-]?key|password|secret|token)["']?\s*[:=]\s*["'][^"'\s]{4,}/i;
const utf8 = new TextDecoder('utf-8',{fatal:true});

function readWorkingFile(root: string, relative: string) {
  const absolute = path.join(realpathSync(root),relative);
  if (realpathSync(absolute) !== absolute) return;
  const fd = openSync(absolute,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return;
    const buf = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buf.length) {
      const n = readSync(fd,buf,count,buf.length-count,null);
      if (!n) break;
      count += n;
    }
    if (count <= maxBytes) return buf.subarray(0,count);
  } finally { closeSync(fd); }
}

// Both sides must be small, ordinary text files. Only use HEAD's copy if its
// bytes match the pause snapshot; otherwise we cannot reconstruct that edit.
export function previewPausedEdit(root: string, base: string | null, name: string, originalSha256: string) {
  if (!base || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(base) || !/^[a-f\d]{64}$/.test(originalSha256) ||
      !textFile.test(name) || sensitiveName.test(name) || path.isAbsolute(name) ||
      name.split(/[\\/]/).some(part => !part || part.startsWith('.')) || /[\x00-\x1f]/.test(name)) return;
  try {
    const afterBytes = readWorkingFile(root,name);
    if (!afterBytes) return;
    const beforeBytes = readGit(['cat-file','blob',base+':'+name],{
      cwd:root,stdio:['ignore','pipe','ignore'],maxBuffer:maxBytes,timeout:1000,env:{...process.env,GIT_NO_LAZY_FETCH:'1'}
    });
    if (beforeBytes.length > maxBytes || createHash('sha256').update(beforeBytes).digest('hex') !== originalSha256) return;
    const texts = [utf8.decode(beforeBytes),utf8.decode(afterBytes)];
    if (texts.some(t=>/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(t) || sensitiveText.test(t) || redactSecrets(t)!==t)) return;
    const [oldLines,newLines] = texts.map(t=>t.replace(/\r\n/g,'\n').split('\n'));
    let first = 0, oldEnd = oldLines.length, newEnd = newLines.length;
    while (first < oldEnd && first < newEnd && oldLines[first] === newLines[first]) first++;
    while (oldEnd > first && newEnd > first && oldLines[oldEnd-1] === newLines[newEnd-1]) { oldEnd--; newEnd--; }
    if (first === oldEnd && first === newEnd) return;
    const fragment = (lines: string[], end: number, sign: string) => {
      const rows = lines.slice(first,Math.min(end,first+3)).map(line=>sign+' '+(line.length>300 ? line.slice(0,299)+'…' : line));
      if (end-first>3) rows.push(sign+' …');
      return rows;
    };
    return [...fragment(oldLines,oldEnd,'-'),...fragment(newLines,newEnd,'+')].join('\n');
  } catch { return; } // A moving working tree or missing Git object still has a path-level change.
}
