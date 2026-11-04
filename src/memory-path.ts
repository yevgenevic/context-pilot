import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Section = 'tasks' | 'rules' | 'ideas' | 'notes';

export function recordId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw Error('Некорректный ID.');
  }
  return value;
}

// .pilot is part of the checkout. A cloned repository can supply symlinks,
// including a dangling link where the coordinator is about to create a file.
export function memoryDirectory(memory: string, section: Section): string {
  const dir = path.join(memory, section);
  for (const entry of [memory, dir]) {
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw Error('Для памяти .pilot нужны обычные каталоги без символических ссылок.');
  }
  return dir;
}

export function memoryFile(memory: string, section: Section, key: unknown): string {
  const filename = recordId(key) + (section === 'notes' ? '.jsonl' : '.json');
  const file = path.join(memoryDirectory(memory, section), filename);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw Error('В .pilot допускаются только обычные файлы без символических ссылок.');
  return file;
}

export function readMemoryFile(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw Error('Запись .pilot должна быть обычным файлом до 32 МиБ.');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function appendMemoryNote(memory: string, task: string, line: string) {
  const file = memoryFile(memory, 'notes', task);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw Error('Для заметки нужен отдельный обычный файл.');
    if (stat.size + Buffer.byteLength(line) > 32 * 1024 * 1024) throw Error('Файл заметок превысит 32 МиБ.');
    writeFileSync(fd,line);
  } finally {
    closeSync(fd);
  }
}

// The file may not exist yet. Check the nearest existing ancestor to handle
// an untracked/new file under a symlinked directory too.
export function projectFile(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw Error('Нужен путь к коду внутри проекта.');
  }
  const check = (relative: string) => {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part =>
        part === '..' || ['.git', '.pilot'].includes(part.toLowerCase()))) {
      throw Error('Нужен путь к коду внутри проекта.');
    }
  };
  const relative = path.relative(root, path.resolve(root, value));
  check(relative);
  const physicalRoot = realpathSync(root);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!lstatSync(current, { throwIfNoEntry: false })) break;
    const target = path.relative(physicalRoot, realpathSync(current));
    if (target) check(target);
  }
  return relative;
}
