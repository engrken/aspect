// Run: node tests/test_batch_browser.js
// Browser-independent regression for server-persisted batch staging/autosave.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const elements = new Map();
const storage = new Map();
const actions = [];
const els = id => {
  if (!elements.has(id)) {
    elements.set(id, {
      id, style: {display: 'block'}, innerText: '', innerHTML: '',
      textContent: '', value: '', checked: false, disabled: false,
      videoWidth: 640, videoHeight: 480, readyState: 4,
      setAttribute(){}, removeAttribute(){}, appendChild(){},
      getContext() {return {drawImage(){}, getImageData(){return {data:new Uint8Array(640*480*4)}}};}
    });
  }
  return elements.get(id);
};
const doc = {
  hidden: false,
  getElementById: els,
  querySelectorAll: () => [],
  createElement: () => ({
    width: 0, height: 0, style: {}, setAttribute(){},
    getContext() {return {drawImage(){},getImageData(){return {data:new Uint8Array(640*480*4)}}};}
  })
};
const fakeBackend = async req => {
  actions.push(req);
  if (req.action === 'SCANNER_SUBMIT') {
    return {success:true,fullName:'Verified Student',studentId:'S01'};
  }
  if (req.action === 'GET_SCAN_REVIEW_QUEUE') {
    return {success:true,jobs:[],pendingCount:0};
  }
  if (req.action === 'GET_SCAN_BATCH_REPORT') {
    return {success:true,summary:{saved:1,pending:0,dismissed:0},records:[]};
  }
  return {success:true};
};
const context = {
  console,
  window: {crypto:{randomUUID:()=> 'batch-id-1'},confirm:()=>true},
  document: doc,
  navigator: {vibrate(){}},
  sessionToken:'unit-session',
  activeClassId: 'CLASS-1',
  enrolledStudentsList:[{studentId:'S01',fullName:'Verified Student'}],
  builderItems: [], performance: {now:()=>0},
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key,val) => storage.set(key,val)
  },
  callApi:fakeBackend,
  setInterval(){return 1}, clearInterval(){},
  alert: error => {throw new Error('Unexpected blocking alert: '+error);}
};
vm.createContext(context);
for (const file of ['scanner.js','batch_scanner.js']) {
  vm.runInContext(fs.readFileSync(
    path.join(__dirname,'../public',file),'utf8'
  ), context);
}
async function exec(source) {
  return vm.runInContext(source,context);
}

(async()=>{
  // The grade endpoint should have staged the candidate first.
  await exec('toggleBatchMode(true)');
  const good = {scanId:'scan-1',detectedQrId:'S01',
    rawScore:50,totalPoints:50,reviewReasons:[],autoSaveEligible:true};
  const before = actions.length;
  await exec("handleBatchScanResult(" + JSON.stringify(good) +
    ",'CLASS-1',activeBatchSessionId())");
  assert.equal(actions.slice(before).filter(a=>a.action==='SCANNER_SUBMIT').length,1);
  assert.equal(elements.get('batch-saved-count').textContent,'1');

  const flagged = {scanId:'scan-2',detectedQrId:'',
    rawScore:12,totalPoints:50,
    reviewReasons:['Student QR code not detected'],autoSaveEligible:false};
  const current = actions.filter(a=>a.action==='SCANNER_SUBMIT').length;
  await exec("handleBatchScanResult(" + JSON.stringify(flagged) +
    ",'CLASS-1',activeBatchSessionId())");
  assert.equal(actions.filter(a=>a.action==='SCANNER_SUBMIT').length,current,
    'Uncertain candidates must never auto-submit grades');
  assert.match(elements.get('batch-result-status').textContent,/Needs review/);
  assert.match(elements.get('batch-result-status').textContent,/No official grade was saved/);

  const wrongClass = actions.filter(a=>a.action==='SCANNER_SUBMIT').length;
  await exec("handleBatchScanResult(" + JSON.stringify(good) +
    ",'CLASS-OTHER',activeBatchSessionId())");
  assert.equal(actions.filter(a=>a.action==='SCANNER_SUBMIT').length,wrongClass,
    'Class switch must not submit the old sheet to the new class');

  console.log('Batch browser tests passed: verified save, review routing, class switch.');
})().catch(e=>{console.error(e);process.exit(1)});
