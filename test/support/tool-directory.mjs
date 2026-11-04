import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Test providers stand in for an installed CLI, outside the project under test.
export function toolDirectory(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pilot-provider-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  return dir;
}
