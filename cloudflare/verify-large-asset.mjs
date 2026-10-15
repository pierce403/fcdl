import { readFileSync, mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
const vacantPort = async () => {const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};
const port=await vacantPort();const inspector=await vacantPort();
const specification=JSON.parse(readFileSync(new URL('./large-assets.sources.json',import.meta.url),'utf8')).files[0];
const source=readFileSync(new URL('../'+specification.source,import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const expectedSha=sha(source);const records=[];
mkdirSync('.wrangler/tmp',{recursive:true});
const logfile=createWriteStream('.wrangler/large-asset-workerd.log');
const env={...process.env,TMPDIR:resolve('.wrangler/tmp'),WRANGLER_SEND_METRICS:'false'};
for(const key of ['CLOUDFLARE_API_TOKEN','CF_API_TOKEN','GH_TOKEN','GITHUB_TOKEN','SSH_AUTH_SOCK'])delete env[key];
const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','dev','--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspector)],{env,detached:true,stdio:['ignore','pipe','pipe']});child.stdout.pipe(logfile);child.stderr.pipe(logfile);
const origin='http://127.0.0.1:'+port;
try {
 let ready=false;
 for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error('Local Worker exited');try{const response=await fetch(origin+'/',{signal:AbortSignal.timeout(1000)});if(response.status===200){ready=true;await response.body.cancel();break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert(ready,'Worker readiness');
 const get=async(name,headers={},method='GET',status=200,start=0,end=source.length-1)=>{
  const response=await fetch(origin+specification.path,{headers:{'Accept-Encoding':'identity',...headers},method,signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,status,name+' status');const bytes=new Uint8Array(await response.arrayBuffer());
  if(status===200||status===206){assert.equal(response.headers.get('content-type'),specification.contentType,name+' MIME');assert.equal(response.headers.get('access-control-allow-origin'),'*',name+' CORS');assert.equal(response.headers.get('content-length'),String(end-start+1),name+' length');assert.equal(bytes.length,method==='HEAD'?0:end-start+1,name+' body length');if(method!=='HEAD')assert.equal(sha(bytes),sha(source.subarray(start,end+1)),name+' bytes');if(status===206)assert.equal(response.headers.get('content-range'),`bytes ${start}-${end}/${source.length}`,name+' range');}
  records.push({name,status,bytes:bytes.length});return response.headers.get('etag');
 };
 const etag=await get('full original digest');assert.equal(etag,'"sha256-'+expectedSha+'"');
 await get('HEAD representation',{},'HEAD');
 await get('first byte',{Range:'bytes=0-0'},'GET',206,0,0);
 await get('suffix',{Range:'bytes=-1024'},'GET',206,source.length-1024,source.length-1);
 const boundary=16*1024*1024;await get('cross-chunk range',{Range:`bytes=${boundary-10}-${boundary+24}`},'GET',206,boundary-10,boundary+24);
 await get('clamped end',{Range:`bytes=${source.length-10}-${source.length+100}`},'GET',206,source.length-10,source.length-1);
 await get('unsatisfiable',{Range:`bytes=${source.length}-`},'GET',416);
 await get('empty suffix',{Range:'bytes=-0'},'GET',416);
 await get('conditional hit',{'If-None-Match':etag},'GET',304);
 await get('weak conditional hit',{'If-None-Match':'W/'+etag},'GET',304);
 await get('If-Range match',{Range:'bytes=4-9','If-Range':etag},'GET',206,4,9);
 await get('If-Range mismatch',{Range:'bytes=4-9','If-Range':'"old"'});
 await get('multi-range full fallback',{Range:'bytes=0-1,4-5'});
 await get('mutation rejected',{},'POST',405);
 await get('CORS preflight',{},'OPTIONS',204);
 const missing=await fetch(origin+'/missing-file-20261014');assert.equal(missing.status,404);await missing.body.cancel();records.push({name:'real404',status:404});
 writeFileSync('.wrangler/large-asset-runtime-evidence.json',JSON.stringify({sourceBytes:source.length,sourceSha256:expectedSha,checks:records,passed:true},null,2)+'\n');console.log(JSON.stringify({passed:true,checks:records.length,sourceBytes:source.length,sourceSha256:expectedSha}));
} finally {
 try{process.kill(-child.pid,'SIGTERM');}catch{}await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,5000))]);logfile.end();
}
