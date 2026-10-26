/**
 * ASPECT Batch Scanner — opt-in, review-first grade processing.
 * Candidate scans are persisted by the teacher-scoped backend. Nothing
 * here writes final grades outside the guarded SCANNER_SUBMIT/REVIEW_SCAN APIs.
 */
let batchScanEnabled = false;
let batchScanPaused = false;
let activeReviewJob = null;
let lastBatchSummary = { saved: 0, pending: 0, dismissed: 0, published: 0 };

function batchSessionKey() {
  return 'aspect_batch_session_' + (activeClassId || 'none');
}

function newBatchIdentifier() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return String(Date.now()) + '-' + String(Math.random()).slice(2);
}

function activeBatchSessionId() {
  if (!activeClassId) return '';
  let value = localStorage.getItem(batchSessionKey());
  if (!value) {
    value = newBatchIdentifier();
    localStorage.setItem(batchSessionKey(), value);
  }
  return value;
}

function isBatchScanEnabled() {
  return batchScanEnabled;
}

function isBatchScanPaused() {
  return batchScanEnabled && batchScanPaused;
}

function batchSetText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function batchEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showBatchFeedback(message, kind) {
  const el = document.getElementById('batch-result-status');
  if (!el) return;
  el.className = 'alert py-2 small mb-2 alert-' + (kind || 'info');
  el.textContent = message;
}

function toggleBatchMode(enabled) {
  batchScanEnabled = !!enabled;
  batchScanPaused = false;
  const pause = document.getElementById('btn-batch-pause');
  if (pause) {
    pause.disabled = !batchScanEnabled;
    pause.textContent = 'Pause Scanning';
  }
  const card = document.getElementById('batch-progress');
  if (card) card.style.display = batchScanEnabled ? 'block' : 'none';
  if (batchScanEnabled) {
    activeBatchSessionId();
    showBatchFeedback('Rapid Batch Mode active. Auto-save requires clear QR, test set, and answers. Uncertain sheets go to Review.', 'primary');
    refreshBatchReport();
    refreshBatchReviewQueue();
    refreshBatchSessions();
    if (!lastScannedData && !isScanningFrame) startAutoScanLoop();
  } else {
    showBatchFeedback('Manual scanning active. Grades require Save Grade to Roster.', 'secondary');
    if (!lastScannedData && !isScanningFrame) startAutoScanLoop();
  }
}

function toggleBatchPause() {
  if (!batchScanEnabled) return;
  batchScanPaused = !batchScanPaused;
  const btn = document.getElementById('btn-batch-pause');
  if (btn) btn.textContent = batchScanPaused ? 'Resume Scanning' : 'Pause Scanning';
  if (batchScanPaused) {
    stopAutoScanLoop();
    showBatchFeedback('Batch scanning paused. Pending scans remain saved to the review queue.', 'secondary');
  } else {
    if (!lastScannedData && !isScanningFrame) startAutoScanLoop();
    showBatchFeedback('Batch scanning resumed. Position a new answer sheet.', 'primary');
  }
}

function startNewBatchSession() {
  if (!activeClassId) return;
  if (!window.confirm('Start a new batch counter? Existing saved grades and review scans will remain unchanged.')) return;
  const id = newBatchIdentifier();
  localStorage.setItem(batchSessionKey(), id);
  lastBatchSummary = { saved: 0, pending: 0, dismissed: 0, published: 0 };
  renderBatchSummary();
  showBatchFeedback('New batch session started. Earlier batches are still available under Previous Batches.', 'success');
  refreshBatchReport();
  refreshBatchSessions();
}

function renderBatchSummary() {
  batchSetText('batch-saved-count', lastBatchSummary.saved || 0);
  batchSetText('batch-pending-count', lastBatchSummary.pending || 0);
  batchSetText('batch-dismissed-count', lastBatchSummary.dismissed || 0);
  batchSetText('batch-published-count', lastBatchSummary.published || 0);
  const target = Math.max(1, Number(document.getElementById('batch-target-count')?.value) || 100);
  const complete = lastBatchSummary.saved || 0;
  batchSetText('batch-target-progress', complete + ' / ' + target + ' saved');
  const bar = document.getElementById('batch-progress-bar');
  if (bar) {
    bar.style.width = Math.min(100, complete * 100 / target) + '%';
    bar.setAttribute('aria-valuenow', String(Math.min(100, Math.round(complete * 100 / target))));
  }
}

async function refreshBatchReport() {
  if (!activeClassId) return null;
  const batchId = activeBatchSessionId();
  const classId = activeClassId;
  const res = await callApi({
    action: 'GET_SCAN_BATCH_REPORT', sessionToken,
    classId, batchId
  });
  if (res.success && classId === activeClassId && batchId === activeBatchSessionId()) {
    lastBatchSummary = res.summary || lastBatchSummary;
    renderBatchSummary();
  }
  return res;
}

async function refreshBatchSessions() {
  if (!activeClassId) return;
  const classId = activeClassId;
  const current = activeBatchSessionId();
  const res = await callApi({
    action: 'GET_SCAN_BATCH_SESSIONS', sessionToken, classId
  });
  if (!res.success || activeClassId !== classId) return;
  const select = document.getElementById('batch-session-select');
  if (!select) return;
  select.innerHTML = '';
  const known = new Set();
  const options = [
    {batchId: current, lastScan: 'Current session', hasUnpublished: false},
    ...(res.sessions || [])
  ];
  options.forEach(item => {
    if (known.has(item.batchId)) return;
    known.add(item.batchId);
    const option = document.createElement('option');
    option.value = item.batchId;
    option.textContent = item.lastScan +
      (item.hasUnpublished ? ' · Unpublished grades' : '');
    option.selected = item.batchId === current;
    select.appendChild(option);
  });
}

function switchBatchSession(value) {
  if (!value) return;
  localStorage.setItem(batchSessionKey(), value);
  lastBatchSummary = {saved:0,pending:0,dismissed:0,published:0};
  renderBatchSummary();
  refreshBatchReport();
  showBatchFeedback('Restored an existing batch session. Review its progress before continuing.', 'info');
}

async function publishCurrentBatch() {
  const batchId = activeBatchSessionId();
  const classId = activeClassId;
  const report = await refreshBatchReport();
  if (!report?.success) {
    showBatchFeedback(report?.message || 'Unable to verify batch status.', 'danger');
    return;
  }
  if (report.summary?.pending) {
    showBatchFeedback('Resolve all pending sheets in this batch before publishing.', 'warning');
    return;
  }
  if (!report.summary?.saved) {
    showBatchFeedback('This batch has no verified grades to publish.', 'warning');
    return;
  }
  if (!window.confirm('Publish every approved grade in this batch to students? Confirm that the roster, answers, and exception reviews are complete.')) return;
  const res = await callApi({
    action: 'PUBLISH_SCAN_BATCH', sessionToken, classId,
    batchId, reviewConfirmed: true
  });
  if (!res.success) {
    showBatchFeedback(res.message || 'Publication failed.', 'danger');
    return;
  }
  showBatchFeedback('Batch published. ' + (res.publishedNow || 0) +
    ' additional grades are now visible to students.', 'success');
  await Promise.all([refreshBatchReport(), refreshBatchSessions()]);
}

async function refreshBatchReviewQueue() {
  if (!activeClassId) return;
  const classId = activeClassId;
  const res = await callApi({
    action: 'GET_SCAN_REVIEW_QUEUE', sessionToken, classId
  });
  if (classId !== activeClassId) return;
  const box = document.getElementById('batch-review-queue');
  if (!box) return;
  if (!res.success) {
    box.textContent = 'Review list unavailable: ' + (res.message || 'Network error');
    return;
  }
  batchSetText('batch-review-total', res.pendingCount || 0);
  if (!res.jobs || !res.jobs.length) {
    box.innerHTML = '<p class="text-success small mb-0">No sheets awaiting review.</p>';
    return;
  }
  box.innerHTML = '';
  res.jobs.forEach(job => {
    const row = document.createElement('div');
    row.className = 'd-flex align-items-center justify-content-between gap-2 border-bottom py-2';
    const info = document.createElement('div');
    info.className = 'small flex-grow-1';
    const title = document.createElement('div');
    title.className = 'fw-bold';
    title.textContent = (job.studentId || 'Unidentified student') + ' · Set ' + job.testSet +
                        ' · ' + job.rawScore + '/' + job.totalPoints;
    const detail = document.createElement('div');
    detail.className = 'text-body-secondary';
    detail.textContent = (job.reasons || []).join('; ') || 'Review required';
    info.appendChild(title);
    info.appendChild(detail);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-outline-warning btn-sm flex-shrink-0';
    button.textContent = 'Review';
    button.addEventListener('click', () => openBatchReview(job.scanId));
    row.appendChild(info);
    row.appendChild(button);
    box.appendChild(row);
  });
}

function batchReviewAnswerOptions(answer, tf) {
  const opts = tf ? ['', 'T', 'F', 'A', 'B'] : ['', 'A', 'B', 'C', 'D'];
  if (answer && !opts.includes(answer)) opts.push(answer);
  return opts.map(opt =>
    '<option value="' + batchEscape(opt) + '"' +
    (opt === answer ? ' selected' : '') +
    '>' + batchEscape(opt || '(Blank)') + '</option>'
  ).join('');
}

async function openBatchReview(scanId) {
  if (!scanId || !activeClassId) return;
  const classId = activeClassId;
  const res = await callApi({
    action: 'GET_SCAN_REVIEW_DETAIL', sessionToken, classId, scanId
  });
  if (classId !== activeClassId) return;
  if (!res.success) {
    showBatchFeedback(res.message || 'Could not load review.', 'danger');
    return;
  }
  activeReviewJob = res.job;
  const panel = document.getElementById('batch-review-detail');
  if (!panel) return;
  panel.style.display = 'block';
  batchSetText('batch-review-title',
    'Review Sheet · ' + (res.job.studentId || 'Unidentified'));
  batchSetText('batch-review-reasons',
    (res.job.reasons || []).join('; ') || 'Manual review requested');

  const image = document.getElementById('batch-review-image');
  if (image) {
    image.src = res.job.scannedImage ?
      'data:image/jpeg;base64,' + res.job.scannedImage : '';
  }
  const student = document.getElementById('batch-review-student');
  if (student) {
    student.innerHTML = '<option value="">Choose enrolled student</option>';
    (enrolledStudentsList || []).forEach(st => {
      const option = document.createElement('option');
      option.value = st.studentId;
      option.textContent = st.fullName + ' (' + st.studentId + ')';
      if (String(st.studentId).toUpperCase() ===
          String(res.job.studentId || '').toUpperCase()) option.selected = true;
      student.appendChild(option);
    });
  }
  const set = document.getElementById('batch-review-set');
  if (set) set.value = res.job.testSet === 'B' ? 'B' : 'A';
  const agree = document.getElementById('batch-review-confirm');
  if (agree) agree.checked = false;
  const note = document.getElementById('batch-review-note');
  if (note) note.value = '';
  const tbody = document.getElementById('batch-review-answers');
  if (tbody) {
    tbody.innerHTML = (res.job.itemBreakdown || []).map(it => {
      const item = String(it.itemNo);
      const answer = String((res.job.answers || {})[item] || '');
      const tf = ['T','F'].includes(String(it.correctAnswer || '').toUpperCase());
      const flag = it.reviewFlag || (answer.includes(',') ? 'Multiple marks' : '');
      return '<tr class="' + (flag ? 'table-warning' : '') + '">' +
             '<td>' + batchEscape(item) + '</td>' +
             '<td><select class="form-select form-select-sm batch-answer-choice" data-item="' +
             batchEscape(item) + '">' + batchReviewAnswerOptions(answer, tf) + '</select></td>' +
             '<td>' + batchEscape(it.correctAnswer) + '</td>' +
             '<td class="small">' + batchEscape(flag || (it.isCorrect ? 'Correct' : 'Incorrect/Blank')) + '</td></tr>';
    }).join('');
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeBatchReview() {
  activeReviewJob = null;
  const panel = document.getElementById('batch-review-detail');
  if (panel) panel.style.display = 'none';
  const image = document.getElementById('batch-review-image');
  if (image) image.removeAttribute('src');
}

async function decideBatchReview(decision) {
  if (!activeReviewJob) return;
  const agree = document.getElementById('batch-review-confirm');
  if (!agree?.checked) {
    showBatchFeedback('Tick the manual verification checkbox before applying a review decision.', 'warning');
    return;
  }
  if (decision === 'DISMISS' &&
      !window.confirm('Dismiss this scan? It will not create or change a grade.')) return;

  const classId = activeClassId;
  const answers = {};
  document.querySelectorAll('.batch-answer-choice').forEach(el => {
    if (el.value) answers[String(el.dataset.item)] = el.value;
  });
  const args = {
    action: 'REVIEW_SCAN', sessionToken, classId,
    scanId: activeReviewJob.scanId, reviewDecision: decision,
    reviewConfirmed: true,
    reviewNote: document.getElementById('batch-review-note')?.value || '',
    reviewedStudentId: document.getElementById('batch-review-student')?.value || '',
    reviewedTestSet: document.getElementById('batch-review-set')?.value || 'A',
    reviewedAnswers: answers
  };
  if (decision === 'SAVE' && !args.reviewedStudentId) {
    showBatchFeedback('Choose an enrolled student first.', 'warning');
    return;
  }
  let res = await callApi(args);
  if (res.duplicate && decision === 'SAVE') {
    if (window.confirm('This student already has a grade for this class. Replace it with the reviewed scan? This operation changes the official grade.')) {
      res = await callApi({ ...args, allowOverwrite: true });
    }
  }
  if (!res.success) {
    showBatchFeedback(res.message || 'Could not complete review.', 'danger');
    return;
  }
  showBatchFeedback(decision === 'SAVE' ?
    'Reviewed grade saved to roster.' : 'Candidate dismissed without changing a grade.', 'success');
  closeBatchReview();
  await Promise.all([refreshBatchReviewQueue(), refreshBatchReport()]);
}

async function handleBatchScanResult(result, classId, batchId) {
  if (!result.scanId) {
    showBatchFeedback('Batch scan did not receive a tracking ID. No grade was saved.', 'danger');
    resetToLiveCamera(true);
    return;
  }
  if (classId !== activeClassId || batchId !== activeBatchSessionId()) {
    // Candidate is safely stored under its original class and batch.
    return;
  }
  // An operator may disable or pause batch processing while a camera/network
  // request is in flight. Preserve the staged scan but do not auto-commit.
  if (!batchScanEnabled || batchScanPaused) {
    showBatchFeedback('Batch processing was paused or switched off during capture. ' +
      'The scan is pending review; no official grade was saved.', 'warning');
  } else if (result.autoSaveEligible) {
    const save = await callApi({
      action: 'SCANNER_SUBMIT', sessionToken, classId, scanId: result.scanId
    });
    if (save.success) {
      showBatchFeedback('Saved: ' + (save.fullName || result.detectedQrId) +
        ' · ' + result.rawScore + '/' + result.totalPoints +
        '. Remove the sheet and insert the next paper.', 'success');
      if (navigator.vibrate) navigator.vibrate([40, 40, 40]);
    } else {
      showBatchFeedback('Needs review: ' + (save.message || 'Save failed') +
        '. The scan remains in the server review queue.', 'warning');
    }
  } else {
    showBatchFeedback('Needs review: ' +
      ((result.reviewReasons || []).join('; ') || 'Uncertain grading') +
      '. No official grade was saved.', 'warning');
  }
  if (classId === activeClassId) {
    await Promise.all([refreshBatchReviewQueue(), refreshBatchReport()]);
    resetToLiveCamera(true);
  }
}

function onBatchClassChanged() {
  closeBatchReview();
  lastBatchSummary = { saved: 0, pending: 0, dismissed: 0, published: 0 };
  renderBatchSummary();
  if (batchScanEnabled) {
    refreshBatchReport();
    refreshBatchReviewQueue();
    refreshBatchSessions();
  }
}

function csvSafe(value) {
  let v = String(value == null ? '' : value);
  // Spreadsheet formula injection protection for CSV exports.
  if (/^[=+@\-\t\r]/.test(v)) v = "'" + v;
  return '"' + v.replace(/"/g, '""') + '"';
}

async function downloadBatchAuditCSV() {
  const report = await refreshBatchReport();
  if (!report?.success) {
    showBatchFeedback(report?.message || 'Cannot load batch export.', 'danger');
    return;
  }
  const headings = [
    'Scan ID', 'Student ID', 'Exam Set', 'Score', 'Total',
    'Status', 'Published', 'Review Reasons', 'Reviewed By', 'Review Note', 'Captured'
  ];
  const lines = [headings.map(csvSafe).join(',')];
  (report.records || []).forEach(r => {
    lines.push([
      r.scanId, r.studentId, r.testSet, r.rawScore, r.totalPoints,
      r.status, r.published ? 'YES' : 'NO', (r.reasons || []).join('; '), r.reviewedBy,
      r.reviewNote, r.createdAt
    ].map(csvSafe).join(','));
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;'
  });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ASPECT_Batch_Audit_' + activeClassId + '.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
