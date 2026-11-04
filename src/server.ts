import {redactJsonString} from './privacy.ts';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
export function dashboard(port: number, snapshot: (task: string | null) => unknown, launch: (idea:string) => Promise<string>, control: (action:'stop'|'resume',id:string) => Promise<string>, answer: (id:string,answers:unknown) => Promise<string>, download:(stage:string)=>string) {
  const page = readFileSync(new URL('../ui/dashboard.html',import.meta.url));
  const assets = new Map(['/dashboard.js','/dashboard.css'].map(name => [name,readFileSync(new URL('../ui/dist' + name,import.meta.url))]));
  const server = createServer(async (req,res) => {
    if (!server.listening) { res.writeHead(503).end(); return; }
    const local = '127.0.0.1:' + (server.address() as {port:number}).port;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== local || req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') {
      res.writeHead(403).end(); return;
    }
    const origin = 'http://' + local;
    let url: URL;
    try {
      const target = req.url || '/';
      if (!target.startsWith('/') || target.startsWith('//')) throw Error();
      url = new URL(target, origin);
      if (url.origin !== origin) throw Error();
    } catch {
      res.writeHead(400).end(); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const site = req.headers['sec-fetch-site'];
      if ((req.headers.origin && req.headers.origin !== origin) ||
          (site && site !== 'same-origin' && site !== 'none')) {
        res.writeHead(403).end(); return;
      }
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
    const action = url.pathname.match(/^\/api\/ideas\/(P-[a-f0-9]{8})\/(stop|resume|answers)$/);
    if (req.method === 'POST' && (url.pathname === '/api/ideas' || action)) {
      if (req.headers.origin !== 'http://' + local || req.headers['x-pilot-action'] !== (action?.[2] ?? 'start') ||
          req.headers['content-type'] !== 'application/json') { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type','application/json; charset=utf-8');
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 64000) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        const {idea,answers} = JSON.parse(Buffer.concat(chunks).toString());
        const id = await (action?.[2]==='answers' ? answer(action[1],answers) : action ? control(action[2] as 'stop'|'resume',action[1]) : launch(idea));
        res.writeHead(202).end(JSON.stringify({id}));
      } catch (err) { res.writeHead(400).end(JSON.stringify({error:(err as Error).message}, redactJsonString)); }
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (url.pathname === '/api/handoff') {
      const stage=url.searchParams.get('task');
      if (!stage || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(stage)) { res.writeHead(400).end('Некорректный ID этапа.'); return; }
      try {
        const markdown=download(stage);
        res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="handoff-'+stage+'.md"'}).end(markdown);
      } catch (err) { res.writeHead(400,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({error:(err as Error).message}, redactJsonString)); }
      return;
    }
    if (url.pathname === '/') { res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(page); return; }
    const asset = assets.get(url.pathname);
    if (asset) {
      res.writeHead(200,{'Content-Type':url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'}).end(asset);
      return;
    }
    if (url.pathname !== '/api/state') { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type','application/json; charset=utf-8');
    try { res.end(JSON.stringify(await snapshot(url.searchParams.get('task')),redactJsonString)); }
    catch (err) { res.writeHead(400).end(JSON.stringify({error:(err as Error).message}, redactJsonString)); }
  });
  server.on('error',err => {console.error('pilot: ' + err.message); process.exitCode = 1;});
  const close = () => { server.close();server.closeAllConnections(); };
  process.once('SIGTERM',close);process.once('SIGINT',close);
  server.listen(port,'127.0.0.1',() => console.log('Context Pilot · http://127.0.0.1:' + (server.address() as {port:number}).port + '/'));
}
