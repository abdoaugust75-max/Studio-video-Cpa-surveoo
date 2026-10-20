'use strict';
// Read-only local/container dependency checks. Never installs or changes credentials.
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..');
function find(dir,name){try{const sub=fs.readdirSync(dir).find(x=>x.startsWith('ffmpeg-'));const f=sub?path.join(dir,sub,'bin',name):path.join(dir,name);if(fs.existsSync(f))return f;}catch(_){}return name;}
function check(name,exe,args){const r=spawnSync(exe,args,{windowsHide:true,timeout:10000,encoding:'utf8'});return{name,ok:r.status===0,detail:r.error?.code||String(r.stdout||r.stderr||'').split(/\r?\n/)[0].slice(0,120)};}
const windows=process.platform==='win32',exe=n=>windows?n+'.exe':n;
const checks=[{name:'Node 22+',ok:Number(process.versions.node.split('.')[0])>=22,detail:process.version},check('FFmpeg',find(path.join(root,'tools','ffmpeg'),exe('ffmpeg')),['-version']),check('FFprobe',find(path.join(root,'tools','ffmpeg'),exe('ffprobe')),['-version']),check('yt-dlp',process.env.VS_YTDLP||(windows&&fs.existsSync(path.join(root,'tools','yt-dlp.exe'))?path.join(root,'tools','yt-dlp.exe'):exe('yt-dlp')),['--version'])];
for(const runtime of ['speech-runtime','agent-runtime']){const p=process.env[runtime==='speech-runtime'?'VS_SPEECH_PYTHON':'VS_AGENT_PYTHON']||path.join(root,'tools',runtime,windows?'Scripts/python.exe':'bin/python');checks.push(check(runtime,p,['-c',runtime==='agent-runtime'?'import nanobot; print("Nanobot import OK")':'import os,sys; from pathlib import Path; dirs=[Path(sys.base_prefix),Path(sys.base_prefix).parent / "native/poppler/Library/bin"]; handles=[os.add_dll_directory(str(p)) for p in dirs if p.is_dir()] if os.name=="nt" else []; import faster_whisper; print("Speech import OK")']));}
console.log(JSON.stringify({ok:checks.every(c=>c.ok),checks,next:'See docs/LOCAL_SETUP.md for missing dependencies. This command does not install anything.'},null,2));process.exitCode=checks.every(c=>c.ok)?0:1;
