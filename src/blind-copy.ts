import {spawn} from 'node:child_process';
import {externalCommand} from './executable.ts';
import {redactSecrets} from './privacy.ts';
import {createHash,randomUUID} from 'node:crypto';
import {constants,closeSync,fstatSync,openSync,readFileSync,mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync,readdirSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {readGit} from './git-read.ts';
import type {BlindCopy} from './workflow.ts';

function excluded(file:string) {
  return file.split('/').some(part=>/^(?:\.git|\.pilot|node_modules|\.env(?:\..*)?|AGENTS\.md|CLAUDE\.md|CODEX\.md|\.claude|\.codex|\.agents|\.autopilot|\.npmrc|SPEC(?:IFICATION)?\.md|BRIEF\.md|REQUIREMENTS\.md|PLAN\.md)$/i.test(part)) || /\.(?:pem|key|p12|pfx)$/i.test(file);
}
function fingerprint(root:string):string {
  const hash=createHash('sha256');
  function visit(relative:string) {
    for(const name of readdirSync(path.join(root,relative)).sort()) {
      const file=path.join(relative,name);
      if(excluded(file.split(path.sep).join('/')))continue;
      const stat=lstatSync(path.join(root,file));
      if(stat.isDirectory())visit(file);
      else if(stat.isFile()){hash.update(file);hash.update('\0');hash.update(readFileSync(path.join(root,file)));}
      else throw Error('В копии появился неподдерживаемый тип файла.');
    }
  }
  visit('');return hash.digest('hex');
}
export function createBlindCopy(root:string, options:{parent?:string;files?:string[];allowEmpty?:boolean}={}) {
  // Read Git's allowlist, then copy bytes into new inodes. No hooks, Git history,
  // authoring instructions, ignored dependencies or secret environment files travel.
  const paths=options.files ?? [...new Set(readGit(['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).split('\0').filter(Boolean))].sort();
  const folder=mkdtempSync(path.join(options.parent ?? realpathSync(tmpdir()),'pilot-blind-'));
  const ignored:string[]=[],copied:string[]=[];let count=0,total=0;
  try {
    for(const file of paths) {
      if(excluded(file)){ignored.push(file);continue;}
      if(path.isAbsolute(file)||file.split(/[\\/]/).includes('..'))throw Error('Некорректный путь копии.');
      let cursor=root;
      for(const part of file.split('/')) {
        cursor=path.join(cursor,part);
        const stat=lstatSync(cursor,{throwIfNoEntry:false});
        if(!stat){cursor='';break;} // A tracked deletion is part of the final tree.
        if(stat.isSymbolicLink())throw Error('Слепая копия не поддерживает символические ссылки: '+file);
      }
      if(!cursor)continue;
      const fd=openSync(cursor,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const stat=fstatSync(fd);
        const physical=realpathSync(cursor);
        const relative=path.relative(realpathSync(root),physical);
        const current=lstatSync(physical);
        if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||current.ino!==stat.ino||current.dev!==stat.dev||stat.nlink!==1)
          throw Error('Файл копии должен принадлежать только проекту: '+file);
        if(!stat.isFile()||stat.size>16*1024*1024)throw Error('Для слепой копии нужен обычный файл до 16 МиБ: '+file);
        const content=readFileSync(fd);total+=content.length;
        if(total>128*1024*1024)throw Error('Копия превышает 128 МиБ. Уберите сборочные артефакты из Git.');
        const dest=path.join(folder,file);mkdirSync(path.dirname(dest),{recursive:true});
        copied.push(file);writeFileSync(dest,content,{flag:'wx',mode:stat.mode&0o777});count++;
      } finally {closeSync(fd);}
    }
    if(!count && !options.allowEmpty)throw Error('В проекте нет файлов для слепой приёмки.');
    // The context handoff machinery can inspect this repository, but it has no
    // history, remotes, config or shared objects from the authoring checkout.
    readGit(['init','-q','--template='],{cwd:folder,encoding:'utf8'});
    const digest=fingerprint(folder);
    const record:BlindCopy={id:randomUUID(),digest,files:count,excluded:ignored,created:new Date().toISOString(),state:'checking'};
    return {root:folder,record,files:copied,unchanged:()=>fingerprint(folder)===digest,cleanup:()=>rmSync(folder,{recursive:true,force:true})};
  } catch(error){rmSync(folder,{recursive:true,force:true});throw error;}
}

// A fresh copy has no node_modules. Reproduce locked dependencies without running
// package lifecycle scripts before the read-only acceptance agent starts.
export async function prepareBlindDependencies(root:string,signal:AbortSignal) {
  let manifest;
  try {manifest=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));}
  catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(!Object.keys({...manifest.dependencies,...manifest.devDependencies}).length)return;
  if(!lstatSync(path.join(root,'package-lock.json'),{throwIfNoEntry:false}))
    throw Error('G4: для независимой установки npm-зависимостей нужен package-lock.json.');
  const npm=externalCommand('npm',root);
  const env={...npm.env};
  // npm exports this user-level setting into npm-run environments, but refuses
  // to accept it as an install-level option. Lifecycle scripts stay disabled.
  for(const key of Object.keys(env))if(/^npm_config_allow_scripts$/i.test(key))delete env[key];
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(npm.file,['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,env,signal,stdio:['ignore','pipe','pipe']});
    let output='';
    const capture=(data:Buffer)=>{output=(output+data.toString()).slice(-4000);};
    child.stdout.on('data',capture);child.stderr.on('data',capture);
    const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
    child.once('error',reject);
    child.once('close',code=>{clearTimeout(timer);if(code===0)resolve();else reject(Error('G4: не удалось подготовить зависимости копии. '+redactSecrets(output)));});
  });
}
