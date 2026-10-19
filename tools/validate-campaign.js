'use strict';
// Local inspection only. Approval is simulated in memory for plan validation;
// no project is approved on disk and the upload path must stop at the hold.
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const {createPublish}=require('../lib/publish');
const {scopedCommercialFacts,scriptPriceError}=require('../lib/commercial-facts');
async function main(){
  const root=path.resolve(__dirname,'..'),dir=path.join(root,'data','studio');
  const args=process.argv.slice(2),runId=args[0];if(!/^CR[a-zA-Z0-9]+$/.test(runId||''))throw Error('Supply one local campaign run ID.');
  const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
  const held=read(path.join(dir,'publish-hold.json')).enabled!==false;if(!held)throw Error('Publishing hold must be enabled before validation.');
  const base='http://127.0.0.1:34567',r=await fetch(base+'/api/v2/campaign/run?id='+encodeURIComponent(runId)),run=await r.json();if(!r.ok||run.publish)throw Error('Choose an existing non-publishing campaign.');
  const artifact=id=>read(path.join(dir,'artifacts',id+'.json')),project=id=>read(path.join(dir,'projects',id+'.json'));
  const accounts=read(path.join(root,'data','fb_config.json')).pages;
  const simulated=new Map(run.profiles.filter(p=>p.videoId).map(p=>[p.project,p.videoId]));
  const publisher=createPublish({store:{artifact,project:id=>({...project(id),approvedArtifact:simulated.get(id)}),page:key=>read(path.join(dir,'pages',key+'.json'))},accounts:()=>accounts,hold:()=>true});
  const checks=[];let pairs=0;
  for(const p of run.profiles){
    if(!p.videoId){checks.push({page:p.key,ok:false,error:'No assembled output',stage:p.status});continue;}
    const video=artifact(p.videoId),audio=artifact(p.ttsId),script=artifact(p.scriptId),exists=fs.existsSync(video.file);
    const stream=video.probe||{},delta=Math.abs((stream.duration||0)-(audio.probe?.duration||0));
    const ffroot=path.join(root,'tools','ffmpeg'),version=fs.readdirSync(ffroot).find(n=>n.startsWith('ffmpeg-')),ff=version?path.join(ffroot,version,'bin','ffmpeg.exe'):'ffmpeg.exe';
    const decoded=exists?spawnSync(ff,['-v','error','-i',video.file,'-f','null','-'],{windowsHide:true,timeout:120000,maxBuffer:1024*1024}):{status:1};
    const list=publisher.destinations(p.key).filter(d=>d.enabled),plan=publisher.plan({artifacts:[video.id],destinations:list.map(d=>d.id)});pairs+=plan.postable||0;
    const kbFile=path.join(root,'data','kb_'+p.key+'.json'),knowledge=fs.existsSync(kbFile)?read(kbFile).map(k=>k.text).join('\n'):'';
    const analysis=read(path.join(dir,'video-understanding',run.analysisId+'.json'));
    const commercial=scopedCommercialFacts({analysis,presentation:run.videoSettings?.pages[p.key],approvedFacts:knowledge});
    const commercialError=scriptPriceError([script.text,script.params?.title,script.params?.caption,p.caption].join(' '),commercial);
    const detail={commercialError,page:p.key,project:p.project,videoId:video.id,videoUrl:p.videoUrl,status:p.status,decodeOk:decoded.status===0,portrait:stream.height>stream.width,hasAudio:stream.hasAudio===true,duration:stream.duration,ttsDuration:audio.probe?.duration,durationDelta:delta,alignment:p.captionTiming,scriptPresent:!!script.text,language:script.params?.language,writer:script.params?.writerModel,destinations:list.map(d=>({id:d.id,name:d.name})),simulatedApprovalPlan:{postable:plan.postable,blocked:plan.blocked,dryRun:plan.dryRun}};
    detail.ok=!commercialError&&exists&&detail.decodeOk&&detail.portrait&&detail.hasAudio&&delta<=.12&&p.captionTiming==='audio_word_alignment'&&!!script.text&&plan.postable===list.length&&list.length>0;
    checks.push(detail);
  }
  const originalFetch=global.fetch;let outbound=0,blocked=false;
  global.fetch=async()=>{outbound++;throw Error('Network forbidden by local validator');};
  try{await publisher.execute({confirm:true});}catch(e){blocked=/paused|no upload/i.test(e.message);}finally{global.fetch=originalFetch;}
  const result={checkedAt:Date.now(),runId,ok:checks.length===7&&checks.every(p=>p.ok)&&pairs===8&&blocked&&outbound===0,profiles:checks,posting:{simulatedApprovalOnly:true,pairs,holdBlocked:blocked,networkCalls:outbound,uploaded:0},note:'Technical decode/timing checks and a simulated approved plan only. No owner approval was saved, no upload permission was exercised, and creative quality is not proved by metadata.'};
  const out=path.join(dir,'local-campaign-validation-'+runId+'.json');fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}
main().catch(e=>{console.error(String(e.message).replace(/AIza[\w-]+/g,'[REDACTED]'));process.exitCode=1;});
