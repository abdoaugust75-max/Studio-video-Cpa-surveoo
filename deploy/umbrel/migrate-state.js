'use strict';
// Run once, offline, against the new VPS copy only. Never changes the PC copy.
const fs=require('fs'),path=require('path');
const target=path.resolve(process.argv[2]||'');
if(!process.argv[2]||target==='/'||!fs.existsSync(path.join(target,'studio','publish-hold.json')))throw Error('Supply the restored data directory');
let mapped=0,quarantined=0;
function map(v){
  if(typeof v==='string'&&/^C:[\\/]Users[\\/]abdelilah[\\/]Desktop[\\/]VideoStudio-MASTER([\\/]|$)/i.test(v)){mapped++;return v.replace(/^C:[\\/]Users[\\/]abdelilah[\\/]Desktop[\\/]VideoStudio-MASTER/i,'/app').replace(/\\/g,'/');}
  if(Array.isArray(v))return v.map(map);
  if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,map(x)]));
  return v;
}
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.json')){let j;try{j=JSON.parse(fs.readFileSync(f,'utf8'));}catch{continue;}let next=map(j);
  if(dir===path.join(target,'studio','jobs')&&['queued','running','pending','in_progress'].includes(next.status)){next.status='failed';next.error='Migration quarantine: prior PC job was not resumed';next.finishedAt=Date.now();quarantined++;}
  if(JSON.stringify(j)!==JSON.stringify(next))fs.writeFileSync(f,JSON.stringify(next,null,2),{mode:0o600});
}}}
walk(target);
const studio=path.join(target,'studio');
for(const name of ['publish-hold.json','automation-settings.json','telegram-private.json']){const f=path.join(studio,name);let j={};try{j=JSON.parse(fs.readFileSync(f,'utf8'));}catch{}j.enabled=name==='publish-hold.json';if(name==='telegram-private.json')j.agentEnabled=false;if(name==='publish-hold.json')j.reason='VPS migration: tests only';fs.writeFileSync(f,JSON.stringify(j,null,2),{mode:0o600});}
for(const e of fs.readdirSync(studio)){if(e.endsWith('.lock'))fs.unlinkSync(path.join(studio,e));}
console.log(JSON.stringify({migratedPaths:mapped,quarantinedJobs:quarantined,publishingHeld:true,automationEnabled:false,telegramPollingEnabled:false}));
