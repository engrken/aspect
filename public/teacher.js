const API_BASE_URL = window.ASPECT_CONFIG?.API_URL || '/api';

let sessionToken = localStorage.getItem('aspect_token') || '';
let classList = [];
let activeClassId = localStorage.getItem('aspect_active_class') || '';
let builderItems = [];
var enrolledStudentsList = [];
let allStudentsList = [];
let activeBuilderSet = 'A';
let currentSubmissions = [];

let isRosterLoaded = false;
let isSubmissionsLoaded = false;
let isBuilderLoaded = false;

async function callApi(payload) {
  try {
    const res = await fetch(API_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    console.error("API Call Error:", err);
    return { success: false, message: err.toString() };
  }
}

function hideGlobalLoader() {
  const loader = document.getElementById('global-loader');
  if (loader) {
    // Instantly allow clicks to pass through the invisible overlay
    loader.style.pointerEvents = 'none'; 
    loader.style.opacity = '0';
    setTimeout(() => { loader.style.display = 'none'; }, 400);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  if (!sessionToken) {
    window.location.href = 'index.html';
    return;
  }

  const auth = await callApi({ action: 'VALIDATE_SESSION', sessionToken });
  if (!auth.valid || auth.user.role !== 'TEACHER') {
    localStorage.removeItem('aspect_token');
    window.location.href = 'index.html';
    return;
  }

  document.getElementById('nav-name').innerText = auth.user.fullName;
  document.getElementById('nav-id').innerText = `Faculty ID: ${auth.user.studentId}`;
  document.getElementById('nav-avatar').innerText = auth.user.fullName.charAt(0);
  document.getElementById('main-dashboard').style.display = 'block';

  document.getElementById('tab-enrollment-btn').addEventListener('show.bs.tab', () => {
    if (!isRosterLoaded) loadSubjectEnrollment();
  });
  document.getElementById('tab-submissions-btn').addEventListener('show.bs.tab', () => {
    if (!isSubmissionsLoaded) loadSubmissionsLedger();
  });
  document.getElementById('tab-builder-btn').addEventListener('show.bs.tab', () => {
    if (!isBuilderLoaded) loadExamBuilder();
  });

  // Unlock the UI instantly before the background tables finish loading
  hideGlobalLoader();
  await loadClasses();
});

function logoutTeacher() {
  localStorage.removeItem('aspect_token');
  localStorage.removeItem('aspect_active_class');
  window.location.href = 'index.html';
}

function initTheme() {
  const theme = localStorage.getItem('aspect_theme') || 'light';
  document.documentElement.setAttribute('data-bs-theme', theme);
  updateThemeIcon(theme);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-bs-theme') || 'light';
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-bs-theme', next);
  localStorage.setItem('aspect_theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const icon = document.getElementById('theme-icon');
  if (!icon) return;
  icon.className = theme === 'dark' ? 'bi bi-sun-fill text-warning' : 'bi bi-moon-stars-fill';
}

function openChangePasswordModal() {
  document.getElementById('new-self-password').value = '';
  new bootstrap.Modal(document.getElementById('password-modal')).show();
}

async function handleChangePassword(e) {
  e.preventDefault();
  const newPassword = document.getElementById('new-self-password').value;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Updating...';

  const res = await callApi({ action: 'CHANGE_PASSWORD', sessionToken, newPassword });
  btn.disabled = false;
  btn.innerHTML = 'Update Password';

  if (res.success) {
    bootstrap.Modal.getInstance(document.getElementById('password-modal')).hide();
    alert("Your password has been updated!");
  } else {
    alert("Error: " + res.message);
  }
}

async function loadFacultyList() {
  const tbody = document.getElementById('faculty-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="5" class="text-center py-5 text-body-secondary"><div class="spinner-border text-primary mb-3" style="width: 2rem; height: 2rem;"></div><br><span class="fw-semibold">Loading faculty accounts...</span></td></tr>';

  const res = await callApi({ action: 'GET_FACULTY', sessionToken });
  tbody.innerHTML = '';

  if (!res.success || !res.faculty || res.faculty.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-body-secondary">No faculty accounts found.</td></tr>';
    return;
  }

  res.faculty.forEach(f => {
    const isPrimaryAdmin = f.facultyId === 'FACULTY-01';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="font-monospace fw-bold">${f.facultyId} ${isPrimaryAdmin ? '<span class="badge bg-primary ms-1">ADMIN</span>' : ''}</td>
      <td class="fw-semibold">${f.fullName}</td>
      <td>${f.department || '—'}</td>
      <td>${f.email || '—'}</td>
      <td class="text-center">
        <button class="btn btn-sm btn-outline-secondary me-1" onclick="openEditFacultyModal('${f.facultyId}', '${f.fullName.replace(/'/g, "\\'")}', '${(f.department || '').replace(/'/g, "\\'")}', '${f.email || ''}')" title="Reset Password / Edit">
          <i class="bi bi-pencil"></i>
        </button>
        ${!isPrimaryAdmin ? `<button class="btn btn-sm btn-outline-danger" onclick="deleteFaculty('${f.facultyId}')" title="Remove"><i class="bi bi-trash"></i></button>` : ''}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function openFacultyModal() {
  document.getElementById('fac-id').value = '';
  document.getElementById('fac-id').readOnly = false;
  document.getElementById('fac-name').value = '';
  document.getElementById('fac-dept').value = 'College of Engineering';
  document.getElementById('fac-email').value = '';
  document.getElementById('fac-password').value = '';
  new bootstrap.Modal(document.getElementById('faculty-modal')).show();
}

function openEditFacultyModal(id, name, dept, email) {
  document.getElementById('fac-id').value = id;
  document.getElementById('fac-id').readOnly = true;
  document.getElementById('fac-name').value = name;
  document.getElementById('fac-dept').value = dept || 'College of Engineering';
  document.getElementById('fac-email').value = email || '';
  document.getElementById('fac-password').value = '';
  new bootstrap.Modal(document.getElementById('faculty-modal')).show();
}

async function handleSaveFaculty(e) {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';

  const facultyData = {
    facultyId: document.getElementById('fac-id').value.trim(),
    fullName: document.getElementById('fac-name').value.trim(),
    department: document.getElementById('fac-dept').value.trim(),
    email: document.getElementById('fac-email').value.trim(),
    password: document.getElementById('fac-password').value
  };

  const res = await callApi({ action: 'REGISTER_FACULTY', sessionToken, facultyData });
  btn.disabled = false;
  btn.innerHTML = 'Save Faculty Account';

  if (res.success) {
    bootstrap.Modal.getInstance(document.getElementById('faculty-modal')).hide();
    await loadFacultyList();
    alert(res.message);
  } else {
    alert("Error saving faculty: " + res.message);
  }
}

async function deleteFaculty(facultyId) {
  if (!confirm(`Remove faculty account "${facultyId}"?`)) return;
  const res = await callApi({ action: 'DELETE_FACULTY', sessionToken, facultyId });
  if (res.success) {
    await loadFacultyList();
  } else {
    alert("Error: " + res.message);
  }
}

async function loadClasses() {
  const tbody = document.getElementById('classes-table-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center py-5 text-body-secondary"><div class="spinner-border text-primary mb-3" style="width: 2rem; height: 2rem;"></div><br><span class="fw-semibold">Retrieving subjects...</span></td></tr>';

  const res = await callApi({ action: 'GET_CLASSES', sessionToken });
  const select = document.getElementById('global-class-select');

  if (!res.success) {
    alert("Session expired: " + res.message);
    logoutTeacher();
    return;
  }

  classList = res.classes || [];
  select.innerHTML = '';
  if (tbody) tbody.innerHTML = '';

  if (classList.length === 0) {
    select.innerHTML = '<option value="">No Subjects</option>';
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-body-secondary">No subjects found. Click "Add New Subject" to begin.</td></tr>';
    return;
  }

  if (!activeClassId || !classList.some(c => c.classId === activeClassId)) {
    activeClassId = classList[0].classId;
    localStorage.setItem('aspect_active_class', activeClassId);
  }

  classList.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.classId;
    opt.innerText = `${c.subjectCode} (${c.defaultSection || 'General'})`;
    if (c.classId === activeClassId) opt.selected = true;
    select.appendChild(opt);

    if (tbody) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="font-monospace fw-bold">${c.subjectCode}</td>
        <td>${c.subjectTitle}</td>
        <td>${c.defaultSection || '—'}</td>
        <td><span class="badge bg-secondary-subtle text-secondary-emphasis">${c.passingPercentage || 70}%</span></td>
        <td><span class="badge bg-primary-subtle text-primary-emphasis">${c.totalItems || 50} Items</span></td>
        <td class="text-center">
          <button class="btn btn-sm btn-outline-primary me-1" onclick="selectClassAndGo('${c.classId}', '#tab-scanner')"><i class="bi bi-camera"></i> Scan</button>
          <button class="btn btn-sm btn-outline-secondary me-1" onclick="openEditClassModal('${c.classId}')"><i class="bi bi-pencil"></i></button>
          <button class="btn btn-sm btn-outline-danger" onclick="deleteClass('${c.classId}')"><i class="bi bi-trash"></i></button>
        </td>
      `;
      tbody.appendChild(tr);
    }
  });

  await onActiveClassChange(activeClassId);
}

async function onActiveClassChange(classId) {
  activeClassId = classId;
  localStorage.setItem('aspect_active_class', classId);
  document.getElementById('global-class-select').value = classId;

  isRosterLoaded = false;
  isSubmissionsLoaded = false;
  isBuilderLoaded = false;

  const activeTab = document.querySelector('.nav-link.active').getAttribute('data-bs-target');
  if (activeTab === '#tab-enrollment') await loadSubjectEnrollment();
  if (activeTab === '#tab-submissions') await loadSubmissionsLedger();
  if (activeTab === '#tab-builder') await loadExamBuilder();

  await loadExamBuilderSilent();
  if (typeof onBatchClassChanged === 'function') {
    onBatchClassChanged();
  }
  if (typeof populateStudentSelect === 'function') {
    populateStudentSelect();
  }
  if (typeof resetToLiveCamera === 'function' &&
      document.getElementById('scanner-video')?.srcObject) {
    resetToLiveCamera(true);
  }
}

function selectClassAndGo(classId, tabTarget) {
  onActiveClassChange(classId).then(() => {
    const btn = document.querySelector(`[data-bs-target="${tabTarget}"]`);
    if (btn) btn.click();
  });
}

function generateBatchPersonalizedPDF() {
  if (!activeClassId) return alert("Select a subject first.");
  window.open(`print_sheets.html?classId=${encodeURIComponent(activeClassId)}`, '_blank');
}

function openClassModal() {
  document.getElementById('modal-class-id').value = '';
  document.getElementById('modal-sub-code').value = '';
  document.getElementById('modal-sub-title').value = '';
  document.getElementById('modal-sub-section').value = '';
  document.getElementById('modal-sub-pass').value = '70';
  document.getElementById('modal-class-title').innerText = 'Create New Subject';
  new bootstrap.Modal(document.getElementById('class-modal')).show();
}

function openEditClassModal(classId) {
  const c = classList.find(x => x.classId === classId);
  if (!c) return;
  document.getElementById('modal-class-id').value = c.classId;
  document.getElementById('modal-sub-code').value = c.subjectCode;
  document.getElementById('modal-sub-title').value = c.subjectTitle;
  document.getElementById('modal-sub-section').value = c.defaultSection || '';
  document.getElementById('modal-sub-pass').value = c.passingPercentage || 70;
  document.getElementById('modal-class-title').innerText = 'Edit Subject Blueprint';
  new bootstrap.Modal(document.getElementById('class-modal')).show();
}

async function handleSaveClass(e) {
  e.preventDefault();
  const classId = document.getElementById('modal-class-id').value;
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';

  const payload = {
    action: 'SAVE_CLASS',
    sessionToken,
    classData: {
      classId,
      subjectCode: document.getElementById('modal-sub-code').value.trim(),
      subjectTitle: document.getElementById('modal-sub-title').value.trim(),
      defaultSection: document.getElementById('modal-sub-section').value.trim(),
      passingPercentage: Number(document.getElementById('modal-sub-pass').value) || 70
    }
  };

  const res = await callApi(payload);
  btn.disabled = false;
  btn.innerHTML = 'Save Subject';

  if (res.success) {
    bootstrap.Modal.getInstance(document.getElementById('class-modal')).hide();
    await loadClasses();
  } else {
    alert("Error saving subject: " + res.message);
  }
}

async function deleteClass(classId) {
  if (!confirm("Are you sure you want to remove this subject? Associated keys will be deleted.")) return;
  const res = await callApi({ action: 'DELETE_CLASS', sessionToken, classId });
  if (res.success) {
    await loadClasses();
  } else {
    alert("Error deleting subject: " + res.message);
  }
}

async function loadSubjectEnrollment() {
  if (!activeClassId) return;
  const c = classList.find(x => x.classId === activeClassId);
  if (c) {
    document.getElementById('enroll-subject-heading').innerText = `${c.subjectCode} — ${c.subjectTitle}`;
    document.getElementById('enroll-subject-subheading').innerText = `Section: ${c.defaultSection || 'None'}`;
  }

  const enrolledTbody = document.getElementById('enrolled-students-body');
  const availableTbody = document.getElementById('available-students-body');
  
  if (enrolledTbody) enrolledTbody.innerHTML = '<tr><td colspan="4" class="text-center py-5 text-body-secondary"><div class="spinner-border text-primary mb-3" style="width: 2rem; height: 2rem;"></div><br><span class="fw-semibold">Loading roster...</span></td></tr>';
  if (availableTbody) availableTbody.innerHTML = '<tr><td colspan="4" class="text-center py-5 text-body-secondary"><div class="spinner-border text-primary mb-3" style="width: 2rem; height: 2rem;"></div><br><span class="fw-semibold">Loading available students...</span></td></tr>';

  const res = await callApi({ action: 'GET_CLASS_ENROLLMENTS', sessionToken, classId: activeClassId });
  if (!res.success) return;

  enrolledStudentsList = res.enrolledStudents || [];
  allStudentsList = res.availableStudents || [];
  isRosterLoaded = true;

  const enrolledBadge = document.getElementById('enrolled-count-badge');
  if (enrolledBadge) enrolledBadge.innerText = `${enrolledStudentsList.length} Enrolled`;

  if (enrolledTbody) {
    enrolledTbody.innerHTML = '';
    if (enrolledStudentsList.length === 0) {
      enrolledTbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-body-secondary">No examinees assigned yet.</td></tr>';
    } else {
      enrolledStudentsList.forEach(s => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="font-monospace">${s.studentId}</td>
          <td class="fw-bold">${s.fullName}</td>
          <td>${s.section || '—'}</td>
          <td class="text-center">
            <button class="btn btn-sm btn-outline-danger" onclick="unassignStudent('${s.studentId}')"><i class="bi bi-x-lg"></i></button>
          </td>
        `;
        enrolledTbody.appendChild(tr);
      });
    }
  }

  renderAvailableList();
}

function renderAvailableList() {
  const tbody = document.getElementById('available-students-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (allStudentsList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-body-secondary">No unassigned students found. Students will appear here once they self-register or via Import.</td></tr>';
    return;
  }

  allStudentsList.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="form-check-input available-chk" value="${s.studentId}"></td>
      <td class="font-monospace">${s.studentId}</td>
      <td class="fw-bold">${s.fullName}</td>
      <td>${s.section || '—'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function toggleSelectAllAvailable(checked) {
  document.querySelectorAll('.available-chk').forEach(c => c.checked = checked);
}

async function assignSelectedStudents() {
  const chks = document.querySelectorAll('.available-chk:checked');
  const studentIds = Array.from(chks).map(c => c.value);
  if (studentIds.length === 0) return alert("Select at least one student.");

  const res = await callApi({ action: 'ASSIGN_STUDENTS', sessionToken, classId: activeClassId, studentIds });
  if (res.success) {
    await loadSubjectEnrollment();
  } else {
    alert("Error assigning: " + res.message);
  }
}

async function autoAssignBySection() {
  const c = classList.find(x => x.classId === activeClassId);
  if (!c || !c.defaultSection) return alert("No Default Section configured.");
  if (!confirm(`Auto-assign all registered students in section "${c.defaultSection}"?`)) return;

  const res = await callApi({ action: 'AUTO_ASSIGN_SECTION', sessionToken, classId: activeClassId, section: c.defaultSection });
  if (res.success) {
    await loadSubjectEnrollment();
  } else {
    alert("Error auto-assigning: " + res.message);
  }
}

async function unassignStudent(studentId) {
  const res = await callApi({ action: 'UNASSIGN_STUDENT', sessionToken, classId: activeClassId, studentId });
  if (res.success) {
    await loadSubjectEnrollment();
  } else {
    alert("Error unassigning: " + res.message);
  }
}

function openImportModal() {
  document.getElementById('import-csv-text').value = '';
  new bootstrap.Modal(document.getElementById('import-students-modal')).show();
}

function parseCSVLine(text) {
  const match = text.match(/(?:"[^"]*"|^[^,]*)(?:,(?:"[^"]*"|[^,]*))*/);
  if (!match) return text.split(',');
  const row = [];
  let inQuotes = false;
  let val = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i+1] === '"') { val += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      row.push(val.trim());
      val = '';
    } else {
      val += char;
    }
  }
  row.push(val.trim());
  return row;
}

async function handleImportStudents(e) {
  e.preventDefault();
  const text = document.getElementById('import-csv-text').value.trim();
  if(!text) return alert("Please paste student data.");

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if(lines.length === 0) return alert("No valid text found.");

  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  let headers = delimiter === '\t' ? lines[0].split('\t') : parseCSVLine(lines[0]);
  headers = headers.map(h => h.toLowerCase().replace(/[^a-z_]/g, ''));
  
  let idCol = headers.findIndex(h => h.includes('id'));
  let emailCol = headers.findIndex(h => h.includes('email'));
  let nameCol = headers.findIndex(h => h.includes('name'));
  let sectionCol = headers.findIndex(h => h.includes('section') || h.includes('sec'));

  let hasHeaders = idCol >= 0 && nameCol >= 0;
  if (!hasHeaders) {
    idCol = 0; nameCol = 1; sectionCol = 2; emailCol = 3;
  }

  const studentsList = [];
  const startIdx = hasHeaders ? 1 : 0;

  for(let i = startIdx; i < lines.length; i++) {
    const cols = delimiter === '\t' ? lines[i].split('\t') : parseCSVLine(lines[i]);
    if(cols.length >= 2) {
      studentsList.push({
        studentId: cols[idCol] ? cols[idCol].trim() : '',
        fullName: cols[nameCol] ? cols[nameCol].trim() : '',
        section: cols[sectionCol] ? cols[sectionCol].trim() : '',
        email: cols[emailCol] ? cols[emailCol].trim() : ''
      });
    }
  }

  if(studentsList.length === 0) return alert("No valid students parsed.");

  const btn = document.getElementById('btn-import');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Importing...';

  const res = await callApi({ action: 'BATCH_IMPORT_STUDENTS', sessionToken, studentsList });
  btn.disabled = false;
  btn.innerHTML = 'Import Students';

  if(res.success) {
    bootstrap.Modal.getInstance(document.getElementById('import-students-modal')).hide();
    alert(res.message);
    await loadSubjectEnrollment();
  } else {
    alert("Error: " + res.message);
  }
}

async function loadExamBuilderSilent() {
  if (!activeClassId) return;
  const res = await callApi({ action: 'GET_FULL_EXAM_CONFIG', sessionToken, classId: activeClassId });
  if (res.success && res.items) {
    builderItems = res.items;
  }
}

async function loadExamBuilder() {
  if (!activeClassId) return;
  const tbody = document.getElementById('builder-items-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="5" class="text-center py-5 text-body-secondary"><div class="spinner-border text-primary mb-3" style="width: 2rem; height: 2rem;"></div><br><span class="fw-semibold">Loading answer keys...</span></td></tr>';

  await loadExamBuilderSilent();
  const c = classList.find(x => x.classId === activeClassId);
  if (c) {
    document.getElementById('builder-class-heading').innerText = `${c.subjectCode}: Answer Key`;
    document.getElementById('builder-class-subheading').innerText = `Configuring ${builderItems.length} Examination Items`;
  }
  isBuilderLoaded = true;
  renderBuilderItems();
}

function switchBuilderSet(setLetter) {
  activeBuilderSet = setLetter;
  renderBuilderItems();
}

function renderBuilderItems() {
  const tbody = document.getElementById('builder-items-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (builderItems.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-body-secondary">No items configured. Click "+ Add" or "Batch".</td></tr>';
    return;
  }

  const targetKey = activeBuilderSet === 'B' ? 'setB' : 'setA';

  builderItems.forEach((it, idx) => {
    it.itemNo = idx + 1;
    const curVal = (it[targetKey] || '').toUpperCase();

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="fw-bold font-monospace text-center">#${it.itemNo}</td>
      <td>
        <select class="form-select form-select-sm" onchange="updateItemType(${idx}, this.value)">
          <option value="MCQ" ${it.type !== 'TF' ? 'selected' : ''}>Multiple Choice (A-D)</option>
          <option value="TF" ${it.type === 'TF' ? 'selected' : ''}>True / False (T/F)</option>
        </select>
      </td>
      <td>
        <input type="number" class="form-control form-control-sm font-monospace text-center" value="${it.points || 1}" min="1" max="10" onchange="updateItemPoints(${idx}, this.value)">
      </td>
      <td>
        <div class="d-flex gap-1.5 align-items-center">
          ${it.type === 'TF' ? renderTfBubbles(idx, curVal, targetKey) : renderMcqBubbles(idx, curVal, targetKey)}
        </div>
      </td>
      <td class="text-center">
        <button class="btn btn-sm btn-outline-danger" onclick="removeItem(${idx})"><i class="bi bi-trash"></i></button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderMcqBubbles(idx, curVal, targetKey) {
  return ['A', 'B', 'C', 'D'].map(opt => `
    <button type="button" class="bubble-btn ${curVal === opt ? 'active' : ''}" onclick="selectKeyOption(${idx}, '${opt}', '${targetKey}')">${opt}</button>
  `).join('');
}

function renderTfBubbles(idx, curVal, targetKey) {
  return ['T', 'F'].map(opt => `
    <button type="button" class="bubble-btn ${curVal === opt ? 'active' : ''}" onclick="selectKeyOption(${idx}, '${opt}', '${targetKey}')">${opt}</button>
  `).join('');
}

function selectKeyOption(idx, val, targetKey) {
  builderItems[idx][targetKey] = val;
  renderBuilderItems();
}

function updateItemType(idx, newType) {
  builderItems[idx].type = newType;
  builderItems[idx].setA = '';
  builderItems[idx].setB = '';
  renderBuilderItems();
}

function updateItemPoints(idx, pts) {
  builderItems[idx].points = Number(pts) || 1;
}

function addNewItem() {
  builderItems.push({ itemNo: builderItems.length + 1, type: 'MCQ', points: 1, setA: 'A', setB: 'A' });
  renderBuilderItems();
}

function removeItem(idx) {
  builderItems.splice(idx, 1);
  renderBuilderItems();
}

function applyBatchGenerator() {
  const mcq = parseInt(document.getElementById('batch-mcq-count').value) || 0;
  const tf = parseInt(document.getElementById('batch-tf-count').value) || 0;

  builderItems = [];
  for (let i = 1; i <= mcq; i++) builderItems.push({ itemNo: i, type: 'MCQ', points: 1, setA: 'A', setB: 'A' });
  for (let i = 1; i <= tf; i++) builderItems.push({ itemNo: mcq + i, type: 'TF', points: 1, setA: 'T', setB: 'T' });

  bootstrap.Modal.getInstance(document.getElementById('batch-modal')).hide();
  renderBuilderItems();
}

async function saveExamBuilder() {
  const btn = document.getElementById('btn-save-builder');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Saving...`;

  const res = await callApi({
    action: 'SAVE_EXAM_CONFIG',
    sessionToken,
    classId: activeClassId,
    items: builderItems
  });

  btn.disabled = false;
  btn.innerHTML = `<i class="bi bi-check2-circle me-1"></i> Save Keys`;
  if (res.success) {
    alert("Exam blueprint and keys successfully saved!");
    await loadClasses();
  } else {
    alert("Error saving blueprint: " + res.message);
  }
}

// --- SUBMISSIONS LEDGER & MANUAL OVERRIDE ---

async function loadSubmissionsLedger() {
  if (!activeClassId) return;
  const tbody = document.getElementById('submissions-table-body');
  tbody.innerHTML = '<tr><td colspan="8" class="text-center py-5 text-body-secondary"><div class="spinner-border text-primary mb-3" style="width: 2rem; height: 2rem;"></div><br><span class="fw-semibold">Retrieving records...</span></td></tr>';

  const res = await callApi({ action: 'GET_SUBMISSIONS', sessionToken, classId: activeClassId });
  tbody.innerHTML = '';

  if (!res.success || !res.submissions || res.submissions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-body-secondary">No scanned exam records found.</td></tr>';
    document.getElementById('kpi-total').innerText = '0';
    document.getElementById('kpi-mean').innerText = '0.00';
    document.getElementById('kpi-pass-rate').innerText = '0%';
    document.getElementById('kpi-range').innerText = '0 - 0';
    return;
  }

  currentSubmissions = res.submissions;
  isSubmissionsLoaded = true;
  let totalScore = 0, passedCount = 0, minScore = 9999, maxScore = -1;

  currentSubmissions.forEach(s => {
    totalScore += s.rawScore;
    if (s.isPassed) passedCount++;
    if (s.rawScore < minScore) minScore = s.rawScore;
    if (s.rawScore > maxScore) maxScore = s.rawScore;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="fw-bold">${s.fullName}</td>
      <td class="font-monospace">${s.studentId}</td>
      <td><span class="badge bg-secondary">${s.testSet || 'A'}</span></td>
      <td class="fw-bold font-monospace">${s.rawScore} / ${s.totalPoints}</td>
      <td class="fw-bold">${s.percentage}</td>
      <td><span class="badge ${s.isPassed ? 'bg-success' : 'bg-danger'}">${s.isPassed ? 'PASSED' : 'FAILED'}</span></td>
      <td class="small text-body-secondary">${s.timestamp}</td>
      <td class="text-center">
        <button class="btn btn-sm btn-outline-primary" onclick="openReviewModal(${s.id})"><i class="bi bi-eye"></i> View</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('kpi-total').innerText = currentSubmissions.length;
  document.getElementById('kpi-mean').innerText = (totalScore / currentSubmissions.length).toFixed(2);
  document.getElementById('kpi-pass-rate').innerText = `${Math.round((passedCount / currentSubmissions.length) * 100)}%`;
  document.getElementById('kpi-range').innerText = `${minScore === 9999 ? 0 : minScore} - ${maxScore === -1 ? 0 : maxScore}`;
}

function openReviewModal(subId) {
  const sub = currentSubmissions.find(s => s.id === subId);
  if (!sub) return;
  
  document.getElementById('review-sub-id').value = sub.id;
  document.getElementById('review-student-name').innerText = sub.fullName;
  document.getElementById('review-student-meta').innerText = `ID: ${sub.studentId} | Test Set: ${sub.testSet}`;
  document.getElementById('review-raw-score').value = sub.rawScore;
  document.getElementById('review-total-points').value = sub.totalPoints;
  document.getElementById('review-answers-json').value = JSON.stringify(sub.answers || {}, null, 2);
  
  const activeClassObj = classList.find(cls => cls.classId === activeClassId);
  document.getElementById('review-class-pass-pct').value = activeClassObj ? activeClassObj.passingPercentage : 70;

  const canvas = document.getElementById('review-canvas');
  const ctx = canvas.getContext('2d');
  
  if (sub.scannedImage) {
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      if (sub.itemBreakdown && typeof drawValidationOverlays === 'function') {
        drawValidationOverlays(ctx, sub.itemBreakdown);
      }
    };
    img.src = "data:image/jpeg;base64," + sub.scannedImage;
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  new bootstrap.Modal(document.getElementById('review-modal')).show();
}

async function handleUpdateScore(e) {
  e.preventDefault();
  const subId = document.getElementById('review-sub-id').value;
  const rawScore = parseInt(document.getElementById('review-raw-score').value, 10);
  const totalPoints = parseInt(document.getElementById('review-total-points').value, 10);
  const passPct = parseInt(document.getElementById('review-class-pass-pct').value, 10) || 70;
  
  let answers = null;
  try {
    answers = JSON.parse(document.getElementById('review-answers-json').value);
  } catch (err) {
    alert("Invalid JSON format in the answers box.");
    return;
  }

  const percentage = totalPoints > 0 ? Math.round((rawScore / totalPoints) * 10000) / 100 : 0;
  const isPassed = percentage >= passPct;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';

  const res = await callApi({
    action: 'UPDATE_SUBMISSION',
    sessionToken,
    submissionId: subId,
    rawScore,
    percentage,
    isPassed,
    answers
  });

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-save me-1"></i> Apply Grade Override';

  if (res.success) {
    bootstrap.Modal.getInstance(document.getElementById('review-modal')).hide();
    await loadSubmissionsLedger();
    alert("Grade successfully updated.");
  } else {
    alert("Error updating score: " + res.message);
  }
}