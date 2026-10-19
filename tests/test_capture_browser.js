// Run: node tests/test_capture_browser.js
// Lightweight browser-DOM regression, no external dependencies.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const els = new Map();
const drawEvents = [];
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
  setInterval(fn,ms){return 5;}, clearInterval(){},
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
  console.log('Browser mocked-capture tests passed.');
})().catch(e=>{console.error(e);process.exit(1);});