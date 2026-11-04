import { execFile } from 'node:child_process';
import { externalCommand } from './executable.ts';

export type CliStatus = {
  state: 'ready' | 'missing' | 'signed_out' | 'unknown';
  label: string;
  instruction: string;
  commands: string[];
};

const missingCodex: CliStatus = {
  state: 'missing', label: 'Нужен Codex CLI',
  instruction: 'Установи Codex в терминале, затем войди в свой аккаунт.',
  commands: ['npm install -g @openai/codex', 'codex login'],
};

async function inspectCodex(): Promise<CliStatus> {
  // Ask the same executable as the runner. Never read or return credentials.
  let command: ReturnType<typeof externalCommand>;
  try { command = externalCommand('codex', process.cwd()); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return missingCodex;
    throw err;
  }
  return new Promise(resolve => {
    const child = execFile(command.file, ['login', 'status'], {
      env: command.env, timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error?.code === 'ENOENT') return resolve(missingCodex);
      const output = stdout + '\n' + stderr;
      if (error && /not logged in|not authenticated/i.test(output)) {
        return resolve({state: 'signed_out', label: 'Нужен вход в Codex',
          instruction: 'Войди в свой аккаунт из терминала.', commands: ['codex login']});
      }
      if (!error && /logged in|authenticated/i.test(output) && !/not logged in|not authenticated/i.test(output)) {
        return resolve({state: 'ready', label: 'Codex готов', instruction: 'Вход подтверждён на этом компьютере.', commands: []});
      }
      resolve({state: 'unknown', label: 'Не удалось проверить Codex',
        instruction: 'Проверь установку и статус входа в терминале.', commands: ['codex --version', 'codex login status']});
    });
    child.stdin?.end();
  });
}

const missingClaude: CliStatus = {state: 'missing', label: 'Claude Code не найден в PATH', instruction: '', commands: []};

async function inspectClaude(): Promise<CliStatus> {
  let command: ReturnType<typeof externalCommand>;
  try { command = externalCommand('claude', process.cwd()); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return missingClaude;
    throw err;
  }
  return new Promise(resolve => {
    const child = execFile(command.file, ['auth', 'status', '--json'], {
      env: command.env, timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8', windowsHide: true,
    }, (error, stdout) => {
      if (error?.code === 'ENOENT') return resolve(missingClaude);
      // The CLI can include account identifiers in its JSON. Only use the boolean.
      let signedIn: unknown;
      try { signedIn = JSON.parse(stdout)?.loggedIn; } catch { /* Older CLIs can return plain text. */ }
      if (!error && signedIn === true) {
        return resolve({state: 'ready', label: 'Claude Code найден, вход выполнен',
          instruction: 'Для ручного продолжения открой файл передачи в Claude Code вместе с проектом.', commands: []});
      }
      if (signedIn === false) {
        return resolve({state: 'signed_out', label: 'Claude Code найден, требуется вход',
          instruction: 'Для ручной передачи через Claude Code войди в аккаунт.', commands: ['claude auth login']});
      }
      resolve({state: 'unknown', label: 'Не удалось проверить вход в Claude Code',
        instruction: 'Проверь Claude Code в терминале.', commands: ['claude --version', 'claude auth status']});
    });
    child.stdin?.end();
  });
}

function cacheStatus(inspect: () => Promise<CliStatus>) {
  let latest: CliStatus | undefined;
  let validUntil = 0;
  let pending: Promise<CliStatus> | undefined;
  return (refresh = false): Promise<CliStatus> => {
    if (!refresh && latest && Date.now() < validUntil) return Promise.resolve(latest);
    pending ??= inspect().then(result => {
      latest = result;
      validUntil = Date.now() + (result.state === 'ready' ? 60_000 : 5_000);
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

export function agentPreflight() {
  const codex = cacheStatus(inspectCodex);
  const claude = cacheStatus(inspectClaude);
  async function status() {
    const [codexStatus, claudeStatus] = await Promise.all([codex(), claude()]);
    return {codex: codexStatus, claude: claudeStatus};
  }
  async function requireReady() {
    const result = await codex(true);
    if (result.state !== 'ready') throw Error([result.label, result.instruction, ...result.commands].join('\n'));
  }
  return {status, requireReady};
}
