// Run: node tests/test_dashboard_loading.js
// Dependency-free dashboard regression: no image transfer until a sheet is viewed.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

function fakeDocument() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      style: {}, className: '', value: '', innerHTML: '', innerText: '', disabled: false,
      children: [], classList: { add() {}, remove() {} },
      appendChild(item) { this.children.push(item); },
      getContext() { return {
        drawImage() {}, save() {}, restore() {}, scale() {}, clearRect() {}
      }; }
    });
    return nodes.get(id);
  };
  return { node, doc: {
    getElementById: node, createElement: () => ({
      style: {}, innerHTML: '', children: [], appendChild(v) { this.children.push(v); },
      querySelector: () => ({ addEventListener() {} })
    }),
    createDocumentFragment: () => ({
      children: [], appendChild(v) { this.children.push(v); }
    }),
    querySelector: () => ({ getAttribute: () => '#tab-classes' }),
    documentElement: { setAttribute() {} }
  } };
}
function buildApp(file, responses, role) {
  const { doc, node } = fakeDocument();
  const calls = [];
  const fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request.action);
    assert.equal(request.sessionToken, undefined, 'Session credentials must stay outside the request body.');
    assert.equal(options.credentials, 'same-origin');
    assert(responses[request.action], 'Unexpected API action: ' + request.action);
    return { json: async () => responses[request.action] };
  };
  let modals = 0;
  class ImageMock {
    constructor() { this.width = 1200; this.height = 1350; }
    set src(_value) { if (this.onload) this.onload(); }
  }
  const context = {
    window: { ASPECT_CONFIG: {}, addEventListener() {} }, document: doc,
    localStorage: {
      getItem(key) {
        if (key === 'aspect_token') return role + '-token';
        if (key === 'aspect_active_class') return 'C1';
        return null;
      },
      setItem() {}, removeItem() {}
    },
    fetch, setTimeout() {}, alert(text) { throw Error('Unexpected alert: ' + text); },
    confirm: () => true, Image: ImageMock,
    bootstrap: { Modal: class { show() { modals++; } } }, console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), context);
  return { context, calls, node, modalCount: () => modals, run: expression =>
    vm.runInContext(expression, context) };
}

async function checkStudent() {
  const app = buildApp('student.js', {
    GET_STUDENT_RESULTS: { success: true, results: [{
      id: 12, subjectCode: 'ECE', subjectTitle: 'Circuits', section: '3A',
      set: 'A', status: 'PASSED', rawScore: 40, totalPoints: 50,
      percentage: '80%', timestamp: '2026-11-06', hasScannedImage: true
    }] },
    GET_SUBMISSION_DETAIL: { success: true, scannedImage: 'JPEG-DATA',
      itemBreakdown: [], answers: { 1: 'A' } }
  }, 'student');
  await app.run('loadStudentResults()');
  assert.deepEqual(app.calls, ['GET_STUDENT_RESULTS'],
    'Student dashboard should request only text summaries initially.');
  await app.run('viewStudentSheet(12)');
  await app.run('viewStudentSheet(12)');
  assert.deepEqual(app.calls, ['GET_STUDENT_RESULTS', 'GET_SUBMISSION_DETAIL'],
    'Opening a sheet repeatedly should fetch its image only once.');
  assert.equal(app.modalCount(), 2);
}

async function checkTeacher() {
  const app = buildApp('teacher.js', {
    GET_CLASSES: { success: true, classes: [{
      classId: 'C1', subjectCode: 'ECE', subjectTitle: 'Circuits',
      defaultSection: '3A', totalItems: 50, passingPercentage: 70
    }] },
    GET_SUBMISSIONS: { success: true, submissions: [{
      id: 44, fullName: '<img src=x onerror=alert(1)>', studentId: 'S1', testSet: 'A',
      rawScore: 40, totalPoints: 50, percentage: '80%',
      isPassed: true, timestamp: '2026-11-06'
    }] },
    GET_SUBMISSION_DETAIL: { success: true, scannedImage: 'JPEG-DATA',
      itemBreakdown: [], answers: { 1: 'A' } }
  }, 'teacher');
  await app.run('loadClasses()');
  assert.deepEqual(app.calls, ['GET_CLASSES'],
    'Opening the teacher dashboard must not eagerly fetch the exam builder.');
  await app.run('loadSubmissionsLedger()');
  const table = app.node('submissions-table-body');
  const row = table.children.at(-1).children[0].innerHTML;
  assert.match(row, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(row, /<img src=x/);
  await app.run('openReviewModal(44)');
  await app.run('openReviewModal(44)');
  assert.deepEqual(app.calls, ['GET_CLASSES', 'GET_SUBMISSIONS', 'GET_SUBMISSION_DETAIL'],
    'Teacher images should be fetched only when requested and cached for repeat review.');
  assert.equal(app.modalCount(), 2);
}

(async () => {
  await checkStudent();
  await checkTeacher();
  console.log('Teacher/student dashboard lightweight-loading tests passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
