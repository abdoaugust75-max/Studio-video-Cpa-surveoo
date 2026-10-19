'use strict';
// Build a source-only release from an explicit allowlist. Never copy private state.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'..');
const target=path.join(root,'release','github-'+new Date().toISOString().replace(/[:.]/g,'-'));
const roots=['AGENTS.md','start.bat','start-pipeline.bat','run_server.bat','watchdog.bat','install_autostart.bat','tools/studio-watchdog.ps1','tools/launch-studio.ps1','tools/install-studio-autostart.ps1','server.js','package.json','.gitignore','.env.example','README.md','lib','public','.github',
  'tests/release.test.js','tests/production-model-routing.js','tests/video-understanding.js','tests/source-continuation.js','tests/provider-audio.test.js','tests/automation.test.js','tests/telegram-agent.test.js','tests/studio-tools.test.js','tools/transcribe-audio.py','tools/alignment_boundaries.py','tools/speech-requirements.txt','tools/setup-speech.ps1','tools/studio-nanobot.py','tools/setup-agent.ps1','tools/prepare-github.js','tools/check-local.js','tools/validate-campaign.js','docs/LOCAL_SETUP.md','docs/LOCAL_VALIDATION_2026-10-18.md','docs/API_AND_AUDIO.md','docs/AUTOMATION.md','docs/PAGE_LEARNING.md','docs/LOCAL_AGENT_AND_STORAGE.md'];
const files=[];
function collect(rel){const full=path.join(root,rel);if(!fs.existsSync(full))throw Error('Release source missing: '+rel);if(fs.lstatSync(full).isSymbolicLink())throw Error('Symlinks are not allowed in release');if(fs.statSync(full).isDirectory()){for(const name of fs.readdirSync(full))collect(path.join(rel,name));}else files.push(rel);}
roots.forEach(collect);
const patterns=[/AIza[A-Za-z0-9_-]{30,}/,/EAA[A-Za-z0-9]{70,}/,/\b\d{6,16}:[A-Za-z0-9_-]{30,}\b/,/gh[pousr]_[A-Za-z0-9]{30,}/,/github_pat_[A-Za-z0-9_]{30,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/https?:\/\/[^/\s:@]+:[^/\s@]+@/];
for(const rel of files){const text=fs.readFileSync(path.join(root,rel),'utf8');if(patterns.some(p=>p.test(text)))throw Error('Potential credential in '+rel+'; release stopped without printing it');}
fs.mkdirSync(target,{recursive:true});
const manifest=[];
for(const rel of files){const bytes=fs.readFileSync(path.join(root,rel)),dest=path.join(target,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,bytes);manifest.push({file:rel.replace(/\\/g,'/'),bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}
fs.writeFileSync(path.join(target,'release-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),privateDataIncluded:false,files:manifest},null,2));
console.log(JSON.stringify({directory:target,files:files.length,credentialScan:'passed',privateDataIncluded:false}));
