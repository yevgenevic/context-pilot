import {execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithStringEncoding} from 'node:child_process';
import {externalCommand} from './executable.ts';

// An untrusted checkout can configure a fsmonitor hook which even git status executes.
const gitReadOptions = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];
type GitOptions = ExecFileSyncOptions & {cwd: string};
export function readGit(args: string[], options: ExecFileSyncOptionsWithStringEncoding & {cwd: string}): string;
export function readGit(args: string[], options: GitOptions): Buffer;
export function readGit(args: string[], options: GitOptions): string | Buffer {
  const {file, env} = externalCommand('git', options.cwd);
  return execFileSync(file, [...gitReadOptions, ...args], {...options, env: {...(options.env ?? env), PATH: env.PATH}});
}
