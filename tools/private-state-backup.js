'use strict';
// Explicit owner-operated backup. Never run automatically or print credentials.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const magic=Buffer.from('VSSTATE1\n');
function safeRelative(p){
  if(typeof p!=='string'||!p||p.includes('\\')||p.includes(':')||p.split('/').some(x=>!x||x==='.'||x==='..')||! /^(data|assets)\//.test(p))throw Error('Unsafe archive path');
  return p;
}
function create(root,bundle,keyFile){
  root=path.resolve(root);bundle=path.resolve(bundle);keyFile=path.resolve(keyFile);
  if(fs.existsSync(bundle)||fs.existsSync(keyFile))throw Error('Backup and recovery key must have new paths');
  const rows=[],skipDirs=new Set(['cache','media','files','frames','audio','videos','tmp','temp','logs']);
  function walk(rel){
    for(const e of fs.readdirSync(path.join(root,rel),{withFileTypes:true})){
      const next=rel+'/'+e.name,full=path.join(root,next);
      if(e.isSymbolicLink())throw Error('Backup does not follow symbolic links');
      if(e.isDirectory()){if(rel.startsWith('data')&&skipDirs.has(e.name))continue;walk(next);}
      else if(e.isFile()){
        if(next.startsWith('data/')&&!/\.(json|jsonl|ndjson|txt|csv|db|sqlite|sqlite3)$/i.test(e.name))continue;
        const bytes=fs.readFileSync(full);rows.push({path:safeRelative(next),bytes:bytes.length,sha256:digest(bytes),content:bytes.toString('base64')});
      }
    }
  }
  walk('data');walk('assets');
  const names=new Set(rows.map(r=>r.path));
  for(const required of ['data/config.json','data/settings.json','data/fb_config.json','data/gemini_keys.txt','data/studio/telegram-private.json','data/studio/publish-hold.json'])if(!names.has(required))throw Error('Required configuration missing: '+required);
  const key=crypto.randomBytes(32),nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce);
  const metadata={format:'VSSTATE1',createdAt:new Date().toISOString(),files:rows.length,bytes:rows.reduce((n,r)=>n+r.bytes,0),excluded:'Downloaded/generated media, cache, temporary files, locks, installed runtimes. Original local files remain unchanged.'};
  const plain=Buffer.from([JSON.stringify(metadata),...rows.map(r=>JSON.stringify(r))].join('\n'));
  const encrypted=Buffer.concat([magic,nonce,cipher.update(zlib.gzipSync(plain)),cipher.final(),cipher.getAuthTag()]);
  fs.mkdirSync(path.dirname(keyFile),{recursive:true});fs.writeFileSync(keyFile,key.toString('hex')+'\n',{flag:'wx',mode:0o600});
  fs.mkdirSync(bundle,{recursive:true});const parts=[];
  for(let at=0;at<encrypted.length;at+=750000){const name='state.part-'+String(parts.length+1).padStart(3,'0')+'.enc',bytes=encrypted.subarray(at,at+750000);fs.writeFileSync(path.join(bundle,name),bytes,{flag:'wx'});parts.push({file:name,bytes:bytes.length,sha256:digest(bytes)});}
  const manifest={...metadata,cipher:'AES-256-GCM',archiveSha256:digest(encrypted),encryptedBytes:encrypted.length,parts};
  fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {files:rows.length,plainBytes:metadata.bytes,encryptedBytes:encrypted.length,parts:parts.length,bundle,keyFile};
}
function read(bundle,keyFile){
  const manifest=JSON.parse(fs.readFileSync(path.join(bundle,'manifest.json'),'utf8'));
  if(manifest.format!=='VSSTATE1'||!Array.isArray(manifest.parts)||!manifest.parts.length||manifest.parts.length>1000)throw Error('Invalid backup manifest');
  const encrypted=Buffer.concat(manifest.parts.map(p=>{
    if(!/^state\.part-\d{3}\.enc$/.test(p.file))throw Error('Unsafe part path');
    const b=fs.readFileSync(path.join(bundle,p.file));if(b.length!==p.bytes||digest(b)!==p.sha256)throw Error('Backup part integrity check failed');return b;
  }));
  if(digest(encrypted)!==manifest.archiveSha256||!encrypted.subarray(0,magic.length).equals(magic))throw Error('Backup archive integrity check failed');
  const hex=fs.readFileSync(keyFile,'utf8').trim();if(!/^[a-f0-9]{64}$/i.test(hex))throw Error('Invalid recovery key format');
  const decipher=crypto.createDecipheriv('aes-256-gcm',Buffer.from(hex,'hex'),encrypted.subarray(magic.length,magic.length+12));decipher.setAuthTag(encrypted.subarray(-16));
  const packed=Buffer.concat([decipher.update(encrypted.subarray(magic.length+12,-16)),decipher.final()]);
  const lines=zlib.gunzipSync(packed,{maxOutputLength:256*1024*1024}).toString('utf8').split('\n');
  const metadata=JSON.parse(lines.shift()),seen=new Set(),rows=lines.map(line=>{
    const r=JSON.parse(line);safeRelative(r.path);if(seen.has(r.path))throw Error('Duplicate archive path');seen.add(r.path);
    const bytes=Buffer.from(r.content,'base64');if(bytes.length!==r.bytes||digest(bytes)!==r.sha256)throw Error('State file integrity check failed');return {path:r.path,bytes};
  });
  if(rows.length!==manifest.files||metadata.files!==rows.length||rows.reduce((n,r)=>n+r.bytes.length,0)!==manifest.bytes)throw Error('Backup file count or size mismatch');
  return {manifest,rows};
}
function restore(bundle,keyFile,target){
  const {manifest,rows}=read(bundle,keyFile);target=path.resolve(target);
  if(fs.existsSync(target))throw Error('Restore target must be a new directory; live state is never overwritten');
  fs.mkdirSync(target,{recursive:true});
  for(const r of rows){const dest=path.join(target,r.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,r.bytes,{flag:'wx',mode:0o600});}
  // A restored snapshot must never turn posting on.
  const studioDir=path.join(target,'data','studio');fs.mkdirSync(studioDir,{recursive:true});
  fs.writeFileSync(path.join(studioDir,'publish-hold.json'),JSON.stringify({enabled:true,reason:'Restored snapshot: publishing requires explicit owner review.'},null,2));
  const settingsPath=path.join(studioDir,'automation-settings.json');let settings={};try{settings=JSON.parse(fs.readFileSync(settingsPath,'utf8'));}catch{}
  settings.enabled=false;fs.writeFileSync(settingsPath,JSON.stringify(settings,null,2));
  return {restoredFiles:manifest.files,target,publishingHeld:true,automationEnabled:false};
}
if(require.main===module){
  try{
    const [command,a,b,c]=process.argv.slice(2);let result;
    if(command==='create'&&a&&b&&c)result=create(a,b,c);
    else if(command==='verify'&&a&&b){const r=read(a,b);result={verified:true,files:r.rows.length,bytes:r.manifest.bytes};}
    else if(command==='restore'&&a&&b&&c)result=restore(a,b,c);
    else throw Error('Usage: private-state-backup.js create <studio-root> <new-bundle-dir> <new-key-file> | verify <bundle-dir> <key-file> | restore <bundle-dir> <key-file> <new-target-dir>');
    console.log(JSON.stringify(result));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={create,read,restore};
