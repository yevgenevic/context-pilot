import {accessSync, constants, existsSync, realpathSync, statSync} from 'node:fs';
import path from 'node:path';

function realPath(file: string): string | undefined {
  try { return realpathSync.native(file); } catch { return undefined; }
}

function within(root: string, file: string) {
  const rel = path.relative(root, file);
  return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// Discover the boundary without executing git from an as-yet unchecked PATH.
// Protect enclosing checkouts as well when starting inside a nested repository.
function enclosingCheckout(cwd: string): string | undefined {
  let largest: string | undefined;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) largest = dir;
    if (dir === path.dirname(dir)) return largest;
  }
}

export function externalCommand(name: 'git' | 'codex' | 'claude', cwd: string, project?: string) {
  const current = realpathSync.native(cwd);
  const boundary = enclosingCheckout(current) ?? (project && realpathSync.native(project));
  const unsafe = (file: string) => boundary ? within(boundary, file) : file === current;
  const directories = new Set<string>();
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(entry) || unsafe(path.normalize(entry))) continue;
    const dir = realPath(entry);
    if (!dir || unsafe(dir)) continue;
    // Keep project-owned interpreters or Git out of child PATH as well. A
    // legitimate external CLI can use /usr/bin/env node or start git itself.
    if (['node','git','codex','claude','sh','bash'].some(tool => {
      const target = realPath(path.join(dir, tool + suffix));
      return target && unsafe(target);
    })) continue;
    directories.add(dir);
  }
  const env = {...process.env, PATH: [...directories].join(path.delimiter)};
  for (const dir of directories) {
    const file = realPath(path.join(dir, name + suffix));
    if (!file || unsafe(file)) continue;
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return {file, env};
    } catch { /* Try the next external installation. */ }
  }
  throw Object.assign(new Error(name + ' не найден вне рабочей копии проекта.'), {code:'ENOENT'});
}
