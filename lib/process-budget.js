'use strict';
const {spawn}=require('child_process');
function createGate(limit){let active=0;const waiting=[];return async function gate(fn){if(active>=limit)await new Promise(r=>waiting.push(r));else active++;try{return await fn();}finally{const next=waiting.shift();if(next)next();else active--;}};}
function stopTree(child){
  if(!child?.pid)return;
  if(process.platform==='win32'){
    // yt-dlp's Windows launcher starts a child interpreter. Killing only the
    // launcher leaves the download running beyond its timeout.
    const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.on('error',()=>{try{child.kill();}catch(_){}});
  }else{try{child.kill('SIGKILL');}catch(_){}}
}
module.exports={createGate,stopTree};
