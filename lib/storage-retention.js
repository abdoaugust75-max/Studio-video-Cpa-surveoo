'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),U=require('./util');
function createStorageRetention({dir,mediaRoot,store,jobs,campaigns,telegram,enabled=true}){
  const root=fs.realpathSync(mediaRoot),cfgFile=path.join(dir,'storage-policy.json'),stateFile=path.join(dir,'storage-state.json'),ledgerFile=path.join(dir,'retired-media.json');
  if(!fs.existsSync(cfgFile))U.writeJsonAtomic(cfgFile,{enabled:true,intervalHours:24,minAgeHours:24,protectLatestPerPage:true});
  const config=()=>{const c=U.readJson(cfgFile,{enabled:false});return{...c,enabled:c.enabled===true,intervalHours:Math.max(24,Number(c.intervalHours)||24),minAgeHours:Math.max(24,Number(c.minAgeHours)||24)};};
  const state=()=>U.readJson(stateFile,{lastRunAt:null});let busy=false;
  function inside(file){const resolved=fs.realpathSync(file),rel=path.relative(root,resolved);return rel!==''&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)?resolved:null;}
  function inventory(){
    const artifacts=fs.readdirSync(store.DIR.artifacts).filter(f=>f.endsWith('.json')).map(f=>U.readJson(path.join(store.DIR.artifacts,f),null)).filter(Boolean),projects=store.listProjects().map(p=>store.project(p.id)).filter(Boolean),protectedProjects=new Set(jobs.list({all:true}).filter(j=>['running','queued','waiting_approval'].includes(j.status)).map(j=>j.project).filter(Boolean)),keepIds=new Set(),owners=new Map(),artifactById=new Map(artifacts.map(a=>[a.id,a]));
    for(const p of projects){if(Object.values(p.publishPairs || {}).some(v=>['uploading','unknown'].includes(v.status)) || p.posting?.status==='uploading')protectedProjects.add(p.id);}
    const latest=new Set();for(const run of campaigns.list())for(const row of run.profiles || [])if(row.videoId&&!latest.has(row.key)){latest.add(row.key);keepIds.add(row.videoId);if(row.project)protectedProjects.add(row.project);}
    // Files referenced by jobs or imported owner assets remain pinned even across project links.
    for(const f of fs.readdirSync(store.DIR.assets).filter(f=>f.endsWith('.json'))){const a=U.readJson(path.join(store.DIR.assets,f),null);if(a?.artifactId)keepIds.add(a.artifactId);}
    for(const a of artifacts)if(a.file){const f=path.resolve(a.file);if(!owners.has(f))owners.set(f,[]);owners.get(f).push(a);}
    const protectedFiles=new Set();for(const [f,refs]of owners)if(refs.some(a=>protectedProjects.has(a.project)||keepIds.has(a.id)))protectedFiles.add(f);
    const candidates=[];let totalBytes=0,protectedBytes=0;const age=config().minAgeHours*3600000;
    function walk(d){for(const entry of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){walk(f);continue;}const stat=fs.statSync(f);totalBytes+=stat.size;const rel=path.relative(root,f),projectId=rel.split(path.sep)[0];if(protectedFiles.has(f)||protectedProjects.has(projectId)||Date.now()-stat.mtimeMs<age){protectedBytes+=stat.size;continue;}const refs=owners.get(f) || [];candidates.push({file:f,bytes:stat.size,mtimeMs:stat.mtimeMs,artifacts:refs.map(a=>a.id),projects:[...new Set(refs.map(a=>a.project).filter(Boolean))],directoryProject:projectId});}}
    walk(root);return{at:Date.now(),totalBytes,protectedBytes,reclaimableBytes:candidates.reduce((n,c)=>n+c.bytes,0),candidates,projects,artifactById,protectedProjects};
  }
  function inspect(){const p=inventory(),ledger=U.readJson(ledgerFile,{files:{}}),purged=Object.values(ledger.files || {}).filter(x=>x.status==='purged');return{policy:config(),state:state(),busy,totalBytes:p.totalBytes,protectedBytes:p.protectedBytes,reclaimableBytes:p.reclaimableBytes,eligibleFiles:p.candidates.length,totalPurgedFiles:purged.length,totalPurgedBytes:purged.reduce((n,x)=>n+x.bytes,0),publicationRecordsPreserved:true};}
  async function clean(){
    if(busy)return{skipped:true,reason:'Cleanup already running'};busy=true;
    try{
      const plan=inventory();let ledger={version:1,files:{},projects:{}};if(fs.existsSync(ledgerFile)){ledger=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));if(!ledger.files||!ledger.projects)throw Error('Retention ledger is invalid; nothing deleted');}
      const projectById=new Map(plan.projects.map(p=>[p.id,p]));
      // Save identity/publication evidence before deleting any bytes. Existing domain JSON stays intact.
      for(const c of plan.candidates){
        for(const id of new Set([...c.projects,c.directoryProject])){const p=projectById.get(id);if(!p)continue;const source=p.source?.url || null;ledger.projects[id]={page:p.page,source,posts:(p.posts || []).map(x=>({id:x.post_id,pageId:x.page_id,url:'https://www.facebook.com/'+x.post_id,verified:x.verification?.verified===true})),publishPairs:p.publishPairs || {},retiredAt:Date.now()};if(source)store.markSourceUsed({url:source,project:id,page:p.page,reason:'retired_after_daily_cleanup'});}
        const rel=path.relative(root,c.file);ledger.files[rel]={bytes:c.bytes,artifacts:c.artifacts,projects:c.projects,status:'planned',at:Date.now()};
      }
      U.writeJsonAtomic(ledgerFile,ledger);
      let removedBytes=0,removedFiles=0;const errors=[];
      let index=0;const liveProtected=new Set(plan.protectedProjects),liveFiles=new Set();
      for(const c of plan.candidates){try{
        if(index++%25===0){await new Promise(resolve=>setImmediate(resolve));for(const j of jobs.list({all:true}).filter(j=>['queued','running','waiting_approval'].includes(j.status))){if(j.project){liveProtected.add(j.project);const p=store.project(j.project);for(const id of p?.artifacts || []){const a=store.artifact?.(id);if(a?.file)liveFiles.add(path.resolve(a.file));}}}}
        if(liveProtected.has(c.directoryProject)||c.projects.some(p=>liveProtected.has(p))||liveFiles.has(c.file))continue;
        if(!fs.existsSync(c.file))continue;const real=inside(c.file);if(!real)throw Error('Path escapes media root');const st=fs.statSync(real);if(st.size!==c.bytes||st.mtimeMs!==c.mtimeMs)continue;
        const hash=crypto.createHash('sha256'),fd=fs.openSync(real,'r'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}const digest=hash.digest('hex');const rel=path.relative(root,c.file);ledger.files[rel].sha256=digest;U.writeJsonAtomic(ledgerFile,ledger);
        fs.unlinkSync(real);removedFiles++;removedBytes+=c.bytes;ledger.files[rel].status='purged';
        for(const id of c.artifacts){const a=plan.artifactById.get(id);if(a)U.writeJsonAtomic(path.join(store.DIR.artifacts,id+'.json'),{...a,retention:{purgedAt:Date.now(),sha256:digest,reason:'daily_24h_retention',originalBytes:c.bytes}});}
      }catch(e){errors.push({file:path.relative(root,c.file),error:String(e.message).slice(0,150)});}}
      U.writeJsonAtomic(ledgerFile,ledger);const result={lastRunAt:Date.now(),removedFiles,removedBytes,errors,publicationRecordsPreserved:true};U.writeJsonAtomic(stateFile,result);
      if(removedFiles)await telegram.notify('cleanup:'+result.lastRunAt,'تنظيف الستوديو: تحيدو '+removedFiles+' ملفات قديمة وتفرغات '+(removedBytes/2**30).toFixed(2)+' جيغا. روابط المصادر وسجل النشر بقاو محفوظين؛ الملفات المحمية ما تمساتش.');return result;
    }finally{busy=false;}
  }
  const timer=enabled?setInterval(()=>{const c=config();if(c.enabled&&Date.now()-(state().lastRunAt || 0)>=c.intervalHours*3600000)clean().catch(e=>U.writeJsonAtomic(stateFile,{...state(),lastErrorAt:Date.now(),error:String(e.message).slice(0,200)}));},60000):null;timer?.unref();
  return{inspect,clean,close:()=>timer&&clearInterval(timer)};
}
module.exports={createStorageRetention};
