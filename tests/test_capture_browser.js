// Run: node tests/test_capture_browser.js
// Lightweight browser-DOM regression, no external dependencies.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const els = new Map();
const drawEvents = [];
const intervalCallbacks = [];
function element(id) {
  if (!els.has(id)) {
    els.set(id, {
      style: {display:'block'}, disabled:false, value:'', innerText:'', innerHTML:'', className:'',
      width:0, height:0, videoWidth:0, videoHeight:0, readyState:4,
      getContext() { return {drawImage(...args){drawEvents.push(['draw',args.length]);},
        getImageData(){return {data:new Uint8Array(640*480*4)};},
        save(){}, restore(){}, scale(){}, beginPath(){}, arc(){}, fill(){}, stroke(){},
        imageSmoothingEnabled:true,imageSmoothingQuality:'high'}; },
      toDataURL() {return 'data:image/jpeg;base64,TESTJPEG';}
    });
  }
  return els.get(id);
}
const context = {
  console, window:{}, performance:{now:()=>2000},
  navigator: {vibrate:()=>{}},
  enrolledStudentsList:[{studentId:'S0001',fullName:'Test Student',section:'ECE'}],
  activeClassId:'C1', sessionToken:'test', builderItems:[{itemNo:1,setA:'A',setB:'A',points:1,type:'MCQ'}],
  jsQR:undefined, ImageCapture:undefined,
  document: {
    hidden:false,
    getElementById:element,
    querySelector(q) {return {value:'A',checked:true};},
    querySelectorAll() {return [];},
    createElement(tag) {
      if(tag === 'canvas') return {...element('canvas-temp-'+Math.random()),width:0,height:0};
      return element(tag);
    }
  },
  Image:class {constructor(){this.naturalWidth=1200;this.naturalHeight=1350;} set src(s){if(this.onload)this.onload();}},
  setInterval(fn,ms){intervalCallbacks.push({fn,ms}); return intervalCallbacks.length;}, clearInterval(){},
  alert(s){throw Error('Unexpected alert: '+s);},
  callApi:async payload=>({
    success:true,studentId:'S0001',detectedTestSet:'A',warpedBase64:'WARPED',
    answers:{}, rawScore:0, totalPoints:1, percentage:0,isPassed:false,
    itemBreakdown:[{itemNo:1,studentAnswer:'(Blank)',correctAnswer:'A',isCorrect:false,bubbles:[]}],
    status:'FAILED'
  })
};
vm.createContext(context);
const code=fs.readFileSync(path.join(__dirname,'../public/scanner.js'),'utf8');
vm.runInContext(code,context);
(async()=>{
  const video=element('scanner-video');
  video.videoWidth=2200;
  video.videoHeight=1650;
  video.style.display='block';
  let canvas=vm.runInContext('drawableToCanvas(document.getElementById("scanner-video"))',context);
  assert.equal(canvas.width,2200);
  assert.equal(canvas.height,1650);
  video.videoWidth=4000;video.videoHeight=3000;
  canvas=vm.runInContext('drawableToCanvas(document.getElementById("scanner-video"))',context);
  assert.equal(canvas.width,2560);
  assert.equal(canvas.height,1920);
  video.videoWidth=2200;video.videoHeight=1650;
  await vm.runInContext('processCameraFrame()',context);
  assert.equal(element('scanner-canvas').style.display,'block');
  assert.equal(element('btn-save-scan').disabled,false);
  assert.equal(element('btn-toggle-scan-photo').style.display,'inline-block');
  await vm.runInContext('toggleScanPhoto()',context);
  assert.equal(element('btn-toggle-scan-photo').innerText,'View Graded Sheet');
  assert(drawEvents.length >= 3);

  // Simulate predictable marker/focus probes to validate the fast auto
  // capture state machine without a physical camera or network.
  vm.runInContext(`
    window.markersVisible = true;
    window.probeSharp = true;
    window.captureCount = 0;
    findFourCornersRobust = () => window.markersVisible ? {
      tl: {x:50,y:50}, tr: {x:590,y:50},
      bl: {x:50,y:430}, br: {x:590,y:430}
    } : null;
    estimateProbeDetail = () => window.probeSharp ? 0.04 : 0.001;
    processCameraFrame = async () => { window.captureCount++; };
  `,context);
  const runProbe = async (timer, count) => {
    for (let i=0;i<count;i++) await timer.fn();
  };

  vm.runInContext('resetToLiveCamera()',context);
  let timer = intervalCallbacks.at(-1);
  assert(timer.ms <= 200, 'reactive probes should not use a long countdown');
  context.window.probeSharp=false;
  await runProbe(timer, 6);
  assert.equal(context.window.captureCount, 0, 'a blurry live preview must not auto-capture');

  context.window.probeSharp=true;
  await runProbe(timer, 2);
  assert.equal(context.window.captureCount, 0, 'capture needs stable multi-frame geometry');
  await runProbe(timer, 1);
  assert.equal(context.window.captureCount, 1, 'sharp and stable markers auto-capture without a fixed wait');

  // After saving, paper must leave the viewfinder so the same paper cannot
  // trigger another capture while staff are moving on to the next one.
  vm.runInContext('resetToLiveCamera(true)',context);
  timer = intervalCallbacks.at(-1);
  await runProbe(timer, 5);
  assert.equal(context.window.captureCount, 1, 'still-visible sheet must not capture again');
  context.window.markersVisible = false;
  await runProbe(timer, 2);
  context.window.markersVisible = true;
  await runProbe(timer, 3);
  assert.equal(context.window.captureCount, 2, 'rearm once the previous sheet is removed');

  console.log('Browser mocked-capture and rapid auto-capture tests passed.');
})().catch(e=>{console.error(e);process.exit(1);});