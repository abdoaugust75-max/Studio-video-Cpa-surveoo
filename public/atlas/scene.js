import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

export function createAtlas({canvas,labels,onSelect}) {
  const renderer=new THREE.WebGLRenderer({canvas,antialias:false,alpha:true});
  renderer.setPixelRatio(1);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.22;
  const scene=new THREE.Scene();scene.fog=new THREE.Fog('#ecebe2',30,80);
  const camera=new THREE.PerspectiveCamera(35,1,.1,120);camera.position.set(13,17,23);
  const controls=new OrbitControls(camera,canvas);controls.target.set(0,1,0);controls.enableDamping=true;controls.maxPolarAngle=Math.PI*.43;controls.minPolarAngle=.25;controls.minDistance=18;controls.maxDistance=40;controls.enablePan=false;
  scene.add(new THREE.HemisphereLight(0xfaffef,0x918574,3));
  const sun=new THREE.DirectionalLight(0xfff3da,4.8);sun.position.set(-9,18,12);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-18,right:18,top:18,bottom:-18,near:1,far:65});sun.shadow.bias=-.0004;sun.shadow.normalBias=.025;scene.add(sun);
  const fill=new THREE.DirectionalLight(0xe2ffff,1.4);fill.position.set(10,9,-10);scene.add(fill);
  const mat=(color,metalness=.1,roughness=.5)=>new THREE.MeshStandardMaterial({color,metalness,roughness});
  const ivory=mat('#e8e6db',.3,.32), porcelain=mat('#faf9f1',.08,.43), teal=mat('#00696b',.6,.28), silver=mat('#aab9b6',.8,.24), dark=mat('#253b3a',.6,.35), brass=mat('#d4ac67',.7,.24), black=mat('#122124',.2,.3);
  const lightMat=new THREE.MeshStandardMaterial({color:'#ffdfa0',emissive:'#ffbb47',emissiveIntensity:1.4,roughness:.3});
  function mesh(geo,material,parent,x=0,y=0,z=0){const m=new THREE.Mesh(geo,material);m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;(parent||scene).add(m);return m;}
  function box(w,h,d,m,p,x=0,y=0,z=0){return mesh(new THREE.BoxGeometry(w,h,d),m,p,x,y,z);}
  function cylinder(r,h,m,p,x=0,y=0,z=0){return mesh(new THREE.CylinderGeometry(r,r,h,40),m,p,x,y,z);}
  function round(w,h,d,r,m,p,x=0,y=0,z=0){const s=new THREE.Shape();s.moveTo(-w/2+r,-d/2);s.lineTo(w/2-r,-d/2);s.quadraticCurveTo(w/2,-d/2,w/2,-d/2+r);s.lineTo(w/2,d/2-r);s.quadraticCurveTo(w/2,d/2,w/2-r,d/2);s.lineTo(-w/2+r,d/2);s.quadraticCurveTo(-w/2,d/2,-w/2,d/2-r);s.lineTo(-w/2,-d/2+r);s.quadraticCurveTo(-w/2,-d/2,-w/2+r,-d/2);const geo=new THREE.ExtrudeGeometry(s,{depth:h,bevelEnabled:true,bevelSegments:3,steps:1,bevelSize:.04,bevelThickness:.04,curveSegments:10});geo.rotateX(-Math.PI/2);geo.translate(0,-h/2,0);return mesh(geo,m,p,x,y,z);}
  const floor=round(23,.35,19,1,ivory,scene,0,-.35,0);
  for(let i=-11;i<=11;i+=1){box(.012,.012,18.4,mat('#d4d6c8'),scene,i,-.16,0);}for(let i=-9;i<=9;i+=1){box(22.4,.012,.012,mat('#d4d6c8'),scene,0,-.15,i);}
  // Satin guardrails and architectural framing are real geometry, not a rendered backdrop.
  for(let x=-11;x<=11;x+=1){cylinder(.026,.8,silver,scene,x,.2,-8.9);}box(22,.035,.045,silver,scene,0,.62,-8.9);
  const positions=[[-5.6,-4.1],[5.4,-4.1],[-7.3,.6],[6.9,.7],[-5.3,5],[0,6.3],[5.5,5.7]];
  const stations=[],pickables=[],packets=[];
  function screen(parent,w,h,x,y,z){const casing=round(w+.18,.12,h+.18,.12,black,parent,x,y,z);casing.rotation.x=Math.PI/2;const surface=mesh(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({color:'#94b4ab'}),parent,x,y,z+.13);return surface;}
  function machine(index,pos){const group=new THREE.Group();group.position.set(pos[0],0,pos[1]);scene.add(group);
    round(3.7,.22,2.9,.42,silver,group,0,.12,0);round(3.5,.4,2.65,.35,ivory,group,0,.43,0);round(3.3,.12,2.5,.25,porcelain,group,0,.73,0);
    box(2.8,.02,.17,lightMat,group,0,.75,1.05);box(2.4,.58,.7,dark,group,0,.37,1.08);
    for(let n=-3;n<=3;n++)box(.14,.2,.25,brass,group,n*.3,.36,1.45);
    // Cabinet, fasteners, workstation display, keyboard, armature and core.
    round(.7,1.8,.6,.09,ivory,group,1.2,1.55,-.6);box(.42,1.3,.04,dark,group,1.2,1.65,-.27);
    for(let n=0;n<6;n++)box(.32,.045,.045,brass,group,1.2,1.05+n*.13,-.23);
    cylinder(.18,.1,silver,group,-.15,.84,-.3);box(.075,.48,.075,silver,group,-.15,1.1,-.3);
    const monitor=screen(group,1.65,1.08,-.15,1.87,-.28);
    round(1.2,.045,.42,.07,dark,group,-.15,.82,.55);for(let n=0;n<4;n++)for(let j=0;j<12;j++)box(.07,.012,.06,silver,group,-.62+j*.083,.852,.41+n*.085);
    const arm=new THREE.Group();arm.position.set(-1.22,.85,-.35);group.add(arm);arm.userData.dynamic=true;cylinder(.18,.09,dark,arm);const joint=cylinder(.09,.48,silver,arm,0,.3,0);joint.rotation.z=.28;const elbow=mesh(new THREE.SphereGeometry(.12,16,12),brass,arm,-.06,.56,0);const lever=box(.07,.5,.07,silver,arm,.11,.77,0);lever.rotation.z=-.7;box(.26,.17,.24,black,arm,.27,.98,0);
    const core=cylinder(.19,.48,teal,group,-1.27,1.18,.67);cylinder(.21,.045,lightMat,group,-1.27,1.44,.67);
    for(const x of [-1.5,1.5])for(const z of [-1.12,1.12])cylinder(.055,.02,brass,group,x,.81,z);
    const ring=mesh(new THREE.TorusGeometry(.24,.025,8,40),brass,group,-1.27,1.45,.67);ring.userData.dynamic=true;ring.rotation.x=Math.PI/2;for(let n=0;n<3;n++){const tooth=new THREE.Mesh(new THREE.BoxGeometry(.09,.06,.06),lightMat);tooth.position.set(Math.cos(n*2.09)*.24,Math.sin(n*2.09)*.24,0);ring.add(tooth);}
    const badge=cylinder(.085,.035,new THREE.MeshStandardMaterial({color:'#76a98b',emissive:'#76a98b',emissiveIntensity:.3}),group,1.32,2.48,-.6);
    group.traverse(obj=>{if(obj.isMesh){obj.userData.station=index;pickables.push(obj);}});
    const label=document.createElement('button');label.className='station-label';label.innerHTML=`<span class="station-number">${index+1}</span><span><strong>Page ${index+1}</strong><small>Awaiting data</small></span>`;label.addEventListener('click',()=>onSelect(index));labels.append(label);
    stations.push({group,monitor,arm,ring,badge,label,pos,index,status:'idle',video:null,texture:null,anchor:new THREE.Vector3(pos[0],3.45,pos[1]),screenMat:monitor.material});
    const start=new THREE.Vector3(0,.12,1.2);const end=new THREE.Vector3(pos[0],.12,pos[1]+1.4);const points=[start,new THREE.Vector3(pos[0]*.45,.12,1.2),new THREE.Vector3(pos[0]*.75,.12,pos[1]+1.4),end];const curve=new THREE.CatmullRomCurve3(points);
    mesh(new THREE.TubeGeometry(curve,50,.17,12,false),teal,scene);const railCurve=new THREE.CatmullRomCurve3(points.map(p=>p.clone().add(new THREE.Vector3(0,.13,0))));mesh(new THREE.TubeGeometry(railCurve,50,.026,8,false),lightMat,scene);
    for(let n=0;n<3;n++){const packet=round(.35,.14,.23,.04,brass,scene);packets.push({mesh:packet,curve,station:index,offset:n/3});}
  }
  positions.forEach((p,i)=>machine(i,p));
  // Main source monitor and slow revolving scan ring.
  cylinder(1.25,.28,silver,scene,0,.15,0);cylinder(1.12,1.3,ivory,scene,0,.9,0);cylinder(1.15,.06,lightMat,scene,0,1.3,0);cylinder(1.2,.12,teal,scene,0,1.65,0);
  const central=new THREE.Group();central.position.set(0,3.85,0);scene.add(central);const sourceScreen=screen(central,2.15,3.5,0,0,0);box(.12,2.9,.12,silver,scene,0,2.7,-.16);
  const scanner=mesh(new THREE.TorusGeometry(1.18,.025,8,80),lightMat,scene,0,1.71,0);scanner.userData.dynamic=true;scanner.rotation.x=Math.PI/2;const scannerMarker=new THREE.Mesh(new THREE.BoxGeometry(.23,.13,.08),brass);scannerMarker.position.set(1.18,0,0);scanner.add(scannerMarker);
  // Batch the hundreds of static cabinet/floor parts into a small set of GPU draws.
  scene.updateMatrixWorld(true);
  const staticBatches=new Map();
  scene.traverse(object=>{if(!object.isMesh||object===sourceScreen||stations.some(s=>s.monitor===object))return;let dynamic=false;for(let parent=object;parent;parent=parent.parent)if(parent.userData.dynamic)dynamic=true;if(dynamic)return;const batch=staticBatches.get(object.material)||[];batch.push(object);staticBatches.set(object.material,batch);});
  for(const [material,parts] of staticBatches){if(parts.length<2)continue;const geometries=parts.map(part=>part.geometry.clone().applyMatrix4(part.matrixWorld));const combined=mergeGeometries(geometries,false);if(!combined){geometries.forEach(g=>g.dispose());continue;}const model=new THREE.Mesh(combined,material);model.castShadow=true;model.receiveShadow=true;scene.add(model);parts.forEach(part=>part.removeFromParent());geometries.forEach(g=>g.dispose());}
  let selected=1,motion=!matchMedia('(prefers-reduced-motion: reduce)').matches,sourceTexture=null,dragStart=null;
  const pointer=new THREE.Vector2(),raycaster=new THREE.Raycaster();
  canvas.addEventListener('pointerdown',e=>dragStart=[e.clientX,e.clientY]);canvas.addEventListener('pointerup',e=>{if(!dragStart||Math.hypot(e.clientX-dragStart[0],e.clientY-dragStart[1])>5)return;const b=canvas.getBoundingClientRect();pointer.set((e.clientX-b.left)/b.width*2-1,-(e.clientY-b.top)/b.height*2+1);raycaster.setFromCamera(pointer,camera);const hit=raycaster.intersectObjects(pickables)[0];if(hit)onSelect(hit.object.userData.station);});
  function resize(){const b=canvas.parentElement.getBoundingClientRect();renderer.setSize(b.width,b.height,false);camera.aspect=b.width/b.height;camera.updateProjectionMatrix();}new ResizeObserver(resize).observe(canvas.parentElement);resize();
  function applyTexture(station,url,id){if(!url||station.url===url)return;station.url=url;if(station.video){station.video.pause();station.video.removeAttribute('src');station.video.load();station.texture?.dispose();}const video=document.createElement('video');video.muted=true;video.playsInline=true;video.preload='auto';video.src=url;video.addEventListener('loadeddata',()=>{video.currentTime=Math.min(.4,video.duration/2);});const texture=new THREE.VideoTexture(video);texture.colorSpace=THREE.SRGBColorSpace;const poster=new THREE.TextureLoader().load('/atlas-preview?id='+encodeURIComponent(id));poster.colorSpace=THREE.SRGBColorSpace;station.monitor.material=new THREE.MeshBasicMaterial({map:poster});video.addEventListener('seeked',()=>{station.monitor.material.map=texture;station.monitor.material.needsUpdate=true;poster.dispose();},{once:true});station.video=video;station.texture=texture;}
  function update(profiles,rows,selectedIndex){selected=selectedIndex;stations.forEach((s,i)=>{const p=profiles[i],r=rows?.find(r=>r.key===p?.key);if(!p)return;s.status=r?.status||'idle';const busy=!['idle','ready','published','failed','needs_connection','cancelled','unknown_upload'].includes(s.status);s.label.querySelector('strong').textContent=p.label.split(' — ').at(-1);s.label.querySelector('small').textContent=s.status.replaceAll('_',' ');s.label.classList.toggle('selected',i===selected);s.label.classList.toggle('busy',busy);s.label.classList.toggle('error',['failed','needs_connection','unknown_upload'].includes(s.status));s.label.setAttribute('aria-label',p.label+' · '+s.status);s.label.setAttribute('aria-pressed',String(i===selected));s.badge.material.color.set(busy?'#e9b352':s.status==='failed'?'#b55540':'#69a98d');s.badge.material.emissive.copy(s.badge.material.color);if(r?.videoUrl)applyTexture(s,r.videoUrl,r.videoId);});}
  function setSource(video,assetId){if(sourceTexture)sourceTexture.dispose();sourceTexture=new THREE.VideoTexture(video);sourceTexture.colorSpace=THREE.SRGBColorSpace;const poster=new THREE.TextureLoader().load('/atlas-preview?id='+encodeURIComponent(assetId));poster.colorSpace=THREE.SRGBColorSpace;sourceScreen.material=new THREE.MeshBasicMaterial({map:poster});video.addEventListener('seeked',()=>{sourceScreen.material.map=sourceTexture;sourceScreen.material.needsUpdate=true;poster.dispose();},{once:true});}
  const v=new THREE.Vector3();let last=0,elapsed=0,frames=0;
  function animate(t){requestAnimationFrame(animate);if(document.hidden||t-last<33||!canvas.offsetWidth)return;const delta=Math.min((t-last)/1000,.1);last=t;if(motion)elapsed+=delta;controls.update();const b=canvas.getBoundingClientRect();stations.forEach(s=>{const busy=!['idle','ready','published','failed','needs_connection','cancelled','unknown_upload'].includes(s.status);if(motion){s.ring.rotation.z=elapsed*.45;s.arm.rotation.y=busy?Math.sin(elapsed*1.6+s.index)*.17:0;}v.copy(s.anchor).project(camera);s.label.style.left=(v.x*.5+.5)*b.width+'px';s.label.style.top=(-v.y*.5+.5)*b.height+'px';s.label.style.visibility=v.z>1?'hidden':'visible';});packets.forEach(p=>{const s=stations[p.station];const busy=!['idle','ready','published','failed','needs_connection','cancelled','unknown_upload'].includes(s.status);p.mesh.visible=busy;if(busy){const pt=p.curve.getPoint((elapsed*.13+p.offset)%1);p.mesh.position.copy(pt).add(new THREE.Vector3(0,.24,0));}});scanner.rotation.z=elapsed*.2;renderer.render(scene,camera);canvas.dataset.frames=String(++frames);}
  requestAnimationFrame(animate);
  return {update,setSource,toggleMotion(){motion=!motion;return motion;},reset(){camera.position.set(13,17,23);controls.target.set(0,1,0);controls.update();},get motion(){return motion;}};
}

