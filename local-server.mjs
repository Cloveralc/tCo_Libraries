import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.TCO_PORT || 41731);
const token = randomBytes(32).toString('hex');
const fileHandles = new Map();
const supported = new Set(['txt','md','markdown','tex','latex','epub','pdf','doc','docx','png','jpg','jpeg','gif','webp','bmp','svg','avif','mp4','webm','ogv','mov','m4v','mp3','wav','ogg','oga','m4a','aac','flac','opus']);
const mimeTypes = new Map(Object.entries({
  '.txt':'text/plain; charset=utf-8','.md':'text/markdown; charset=utf-8','.markdown':'text/markdown; charset=utf-8',
  '.tex':'text/plain; charset=utf-8','.latex':'text/plain; charset=utf-8','.epub':'application/epub+zip','.pdf':'application/pdf',
  '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.bmp':'image/bmp','.svg':'image/svg+xml','.avif':'image/avif',
  '.mp4':'video/mp4','.webm':'video/webm','.ogv':'video/ogg','.mov':'video/quicktime','.m4v':'video/x-m4v',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.oga':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.flac':'audio/flac','.opus':'audio/ogg'
}));

function send(response, status, body, type='text/plain; charset=utf-8') {
  response.writeHead(status, {'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
  response.end(body);
}

function authorized(request, url) {
  const origin = request.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!['127.0.0.1','localhost'].includes(parsed.hostname) || parsed.port !== String(port)) return false;
    } catch { return false; }
  }
  const supplied = String(request.headers['x-tco-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(supplied);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request, maxBytes=16384) {
  const chunks=[];
  let length=0;
  for await (const chunk of request) {
    length+=chunk.length;
    if (length>maxBytes) throw Object.assign(new Error('请求内容过大。'),{status:413});
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求格式无效。'),{status:400}); }
}

async function scanDirectory(requestedPath) {
  if (typeof requestedPath!=='string' || !requestedPath.trim()) throw Object.assign(new Error('请提供文件夹的完整路径。'),{status:400});
  const root = await fsp.realpath(path.resolve(requestedPath.trim()));
  const rootStat = await fsp.stat(root);
  if (!rootStat.isDirectory()) throw Object.assign(new Error('指定路径不是文件夹。'),{status:400});
  const files=[];
  const directories=[''];
  async function walk(current, relative='') {
    const children=await fsp.readdir(current,{withFileTypes:true});
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const childRelative=relative?`${relative}/${child.name}`:child.name;
      const absolute=path.join(current,child.name);
      if (child.isDirectory()) {
        directories.push(childRelative);
        await walk(absolute,childRelative);
      } else if (child.isFile() && supported.has(path.extname(child.name).slice(1).toLowerCase())) {
        const stat=await fsp.stat(absolute);
        const id=randomUUID();
        fileHandles.set(id,{absolute,name:child.name});
        const extension=path.extname(child.name).toLowerCase();
        files.push({id,name:child.name,ext:extension,size:stat.size,time:stat.mtimeMs,path:childRelative,url:`/api/library/file/${id}?token=${token}`});
        if (files.length>200000) throw Object.assign(new Error('文件夹中的受支持文件超过 200,000 个，请选择更小的目录。'),{status:413});
      }
    }
  }
  await walk(root);
  return {root,label:path.basename(root)||root,files,directories};
}

function serveFile(request,response,url,id) {
  const entry=fileHandles.get(id);
  if (!entry) return send(response,404,'文件引用已失效，请重新执行 load。');
  fs.stat(entry.absolute,(statError,stat)=>{
    if (statError || !stat.isFile()) return send(response,404,'文件不存在或不可读取。');
    const type=mimeTypes.get(path.extname(entry.name).toLowerCase())||'application/octet-stream';
    const headers={'Content-Type':type,'Content-Length':stat.size,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Disposition':`inline; filename*=UTF-8''${encodeURIComponent(entry.name)}`};
    const range=request.headers.range;
    if (range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) { response.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return response.end(); }
      const start=match[1]?Number(match[1]):Math.max(0,stat.size-Number(match[2]||0));
      const end=match[1]?Math.min(stat.size-1,Number(match[2]||stat.size-1)):stat.size-1;
      if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=stat.size) { response.writeHead(416,{'Content-Range':`bytes */${stat.size}`});return response.end(); }
      headers['Content-Range']=`bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length']=end-start+1;
      response.writeHead(206,headers);
      if (request.method==='HEAD') return response.end();
      fs.createReadStream(entry.absolute,{start,end}).pipe(response);
      return;
    }
    response.writeHead(200,headers);
    if (request.method==='HEAD') return response.end();
    fs.createReadStream(entry.absolute).pipe(response);
  });
}

function serveStatic(request,response,url) {
  let pathname;
  try { pathname=decodeURIComponent(url.pathname); }
  catch { return send(response,400,'请求路径无效。'); }
  if (pathname==='/' || pathname==='/library.html') pathname='/library.html';
  const first=pathname.split('/').filter(Boolean)[0];
  if (first!=='assets' && pathname!=='/library.html') return send(response,404,'Not found');
  const absolute=path.resolve(appRoot,`.${pathname}`);
  const relative=path.relative(appRoot,absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return send(response,403,'Forbidden');
  fsp.readFile(absolute).then(data=>{
    const ext=path.extname(absolute).toLowerCase();
    const type=ext==='.html'?'text/html; charset=utf-8':mimeTypes.get(ext)||({'.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'})[ext]||'application/octet-stream';
    if (ext==='.html') data=Buffer.from(data.toString('utf8').replace('</head>',`<meta name="tco-local-token" content="${token}"></head>`));
    response.writeHead(200,{'Content-Type':type,'Content-Length':data.length,'X-Content-Type-Options':'nosniff','Cache-Control':ext==='.html'?'no-store':'public, max-age=3600'});
    response.end(data);
  }).catch(()=>send(response,404,'Not found'));
}

const server=http.createServer(async (request,response)=>{
  const url=new URL(request.url||'/',`http://${request.headers.host||`${host}:${port}`}`);
  if (url.pathname.startsWith('/api/')) {
    if (!authorized(request,url)) return send(response,403,'本地文库服务未授权。');
    if (request.method==='POST' && url.pathname==='/api/library/scan') {
      try {
        const body=await readJson(request);
        const result=await scanDirectory(body.path);
        return send(response,200,JSON.stringify({root:result.root,label:result.label,files:result.files,directories:result.directories}),'application/json; charset=utf-8');
      } catch (error) { return send(response,error.status||400,JSON.stringify({error:error.message||'无法读取此文件夹。'}),'application/json; charset=utf-8'); }
    }
    const match=/^\/api\/library\/file\/([\w-]+)$/.exec(url.pathname);
    if (match && ['GET','HEAD'].includes(request.method)) return serveFile(request,response,url,match[1]);
    return send(response,404,'Not found');
  }
  if (request.method!=='GET' && request.method!=='HEAD') return send(response,405,'Method not allowed');
  serveStatic(request,response,url);
});

server.on('error',error=>{
  if (error.code==='EADDRINUSE') console.error(`端口 ${port} 已被占用。可设置环境变量 TCO_PORT 后重试。`);
  else console.error(error);
  process.exitCode=1;
});
server.listen(port,host,()=>{
  console.log(`tCo Libraries 本地服务已启动：http://${host}:${port}/library.html`);
  console.log('仅监听本机回环地址；关闭此窗口即可停止服务。');
});
