const API_BASE_URL = window.ASPECT_CONFIG?.API_URL || '/api';

let currentUser = null;
let sessionToken = localStorage.getItem('aspect_token') || null;
let authModal = null;
let forcePasswordModal = null;
let currentStudentResults = [];

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

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-bs-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-bs-theme', next);
  localStorage.setItem('aspect_theme', next);
  const themeIcon = document.getElementById('theme-icon');
  if (themeIcon) {
    themeIcon.className = next === 'dark' ? 'bi bi-sun-fill text-warning' : 'bi bi-moon-stars-fill';
  }
}

function openAuthModal(mode = 'login') {
  switchAuthMode(mode);
  if (authModal) authModal.show();
}

function switchAuthMode(mode) {
  clearAuthAlert();
  const loginForm = document.getElementById('form-login');
  const regForm = document.getElementById('form-register');
  const btnLoginTab = document.getElementById('tab-btn-login');
  const btnRegTab = document.getElementById('tab-btn-register');

  if (mode === 'register') {
    loginForm.classList.add('d-none');
    regForm.classList.remove('d-none');
    btnLoginTab.classList.remove('active');
    btnRegTab.classList.add('active');
    setTimeout(() => document.getElementById('reg-id')?.focus(), 150);
  } else {
    regForm.classList.add('d-none');
    loginForm.classList.remove('d-none');
    btnRegTab.classList.remove('active');
    btnLoginTab.classList.add('active');
    setTimeout(() => document.getElementById('auth-id')?.focus(), 150);
  }
}

function togglePasswordVisibility(inputId, iconId) {
  const pwdInput = document.getElementById(inputId);
  const eyeIcon = document.getElementById(iconId);
  if (!pwdInput) return;
  if (pwdInput.type === 'password') {
    pwdInput.type = 'text';
    if (eyeIcon) eyeIcon.className = 'bi bi-eye-slash';
  } else {
    pwdInput.type = 'password';
    if (eyeIcon) eyeIcon.className = 'bi bi-eye';
  }
}

function setAuthAlert(message, type = 'danger') {
  const el = document.getElementById('auth-alert');
  el.className = `alert alert-${type} py-1.5 px-2 small mb-3 text-center`;
  el.innerText = message;
  el.classList.remove('d-none');
}

function clearAuthAlert() {
  const el = document.getElementById('auth-alert');
  el.classList.add('d-none');
  el.innerText = '';
}

function setForceAlert(message, type = 'danger') {
  const el = document.getElementById('force-alert');
  el.className = `alert alert-${type} py-1.5 px-2 small mb-3 text-center`;
  el.innerText = message;
  el.classList.remove('d-none');
}

function showGuestState() {
  document.getElementById('guest-view').style.display = 'block';
  document.getElementById('student-main').style.display = 'none';
  const dropdown = document.getElementById('nav-user-dropdown');
  if (dropdown) dropdown.classList.add('d-none');
}

function checkPasswordForce() {
  if (currentUser && currentUser.mustChangePassword) {
    showGuestState();
    if (!forcePasswordModal) {
      forcePasswordModal = new bootstrap.Modal(document.getElementById('force-password-modal'));
    }
    forcePasswordModal.show();
    return true;
  }
  return false;
}

window.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('aspect_theme') || 'light';
  document.documentElement.setAttribute('data-bs-theme', savedTheme);
  const modalEl = document.getElementById('auth-modal');
  if (modalEl) authModal = new bootstrap.Modal(modalEl);

  if (sessionToken) {
    callApi({ action: 'VALIDATE_SESSION', sessionToken: sessionToken })
      .then(res => {
        if (res.valid) {
          if (res.user.role === 'TEACHER') {
            window.location.href = 'teacher.html';
            return;
          }
          currentUser = res.user;
          if (checkPasswordForce()) {
            hideGlobalLoader();
            return;
          }
          initStudentDashboard();
          hideGlobalLoader();
        } else {
          localStorage.removeItem('aspect_token');
          sessionToken = null;
          showGuestState();
          hideGlobalLoader();
        }
      })
      .catch(() => {
        showGuestState();
        hideGlobalLoader();
      });
  } else {
    showGuestState();
    hideGlobalLoader();
  }
});

async function loginWithPassword(e) {
  if (e) e.preventDefault();
  const id = document.getElementById('auth-id').value.trim();
  const password = document.getElementById('auth-password').value;

  if (!id || !password) {
    return setAuthAlert('Please enter both your ID and password.');
  }

  clearAuthAlert();
  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Signing In...`;

  try {
    const res = await callApi({ action: 'LOGIN', studentId: id, password: password });
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-box-arrow-in-right me-1"></i> Sign In`;

    if (res.success) {
      sessionToken = res.sessionToken;
      currentUser = res.user;
      localStorage.setItem('aspect_token', sessionToken);
      if (authModal) authModal.hide();

      if (currentUser.role === 'TEACHER') {
        window.location.href = 'teacher.html';
      } else {
        if (checkPasswordForce()) return;
        initStudentDashboard();
      }
    } else {
      setAuthAlert(res.message || 'Invalid ID or password.');
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-box-arrow-in-right me-1"></i> Sign In`;
    setAuthAlert('Connection error while contacting server.');
  }
}

async function submitForcedPassword(e) {
  e.preventDefault();
  const pwd = document.getElementById('force-new-pwd').value;
  if (pwd.length < 6) return setForceAlert('Must be at least 6 characters.');
  
  const btn = document.getElementById('btn-force-pwd');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Saving...`;

  const res = await callApi({ action: 'CHANGE_PASSWORD', sessionToken, newPassword: pwd });
  btn.disabled = false;
  btn.innerHTML = `Save Password & Continue`;

  if (res.success) {
    currentUser.mustChangePassword = false;
    if (forcePasswordModal) forcePasswordModal.hide();
    initStudentDashboard();
  } else {
    setForceAlert(res.message);
  }
}

async function registerStudent(e) {
  if (e) e.preventDefault();
  const studentId = document.getElementById('reg-id').value.trim();
  const fullName = document.getElementById('reg-name').value.trim();
  const section = document.getElementById('reg-section').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;

  if (!studentId || !fullName || !section || !password) {
    return setAuthAlert('Please fill out all required fields.');
  }

  clearAuthAlert();
  const btn = document.getElementById('btn-register');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Registering...`;

  try {
    const res = await callApi({
      action: 'REGISTER_STUDENT',
      studentId,
      fullName,
      section,
      email,
      password
    });

    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-person-check-fill me-1"></i> Complete Registration`;

    if (res.success) {
      sessionToken = res.sessionToken;
      currentUser = res.user;
      localStorage.setItem('aspect_token', sessionToken);
      if (authModal) authModal.hide();
      initStudentDashboard();
    } else {
      setAuthAlert(res.message || 'Registration failed.');
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-person-check-fill me-1"></i> Complete Registration`;
    setAuthAlert('Connection error while registering.');
  }
}

function openProfileModal() {
  document.getElementById('prof-name').value = currentUser.fullName || '';
  document.getElementById('prof-email').value = currentUser.email || '';
  document.getElementById('prof-password').value = '';
  new bootstrap.Modal(document.getElementById('profile-modal')).show();
}

async function updateProfile(e) {
  e.preventDefault();
  const fullName = document.getElementById('prof-name').value.trim();
  const email = document.getElementById('prof-email').value.trim();
  const password = document.getElementById('prof-password').value;

  const btn = document.getElementById('btn-save-prof');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Saving...';

  const res = await callApi({
    action: 'UPDATE_STUDENT_PROFILE',
    sessionToken,
    fullName,
    email,
    password
  });

  btn.disabled = false;
  btn.innerHTML = 'Save Changes';

  if (res.success) {
    currentUser.fullName = fullName;
    currentUser.email = email;
    document.getElementById('profile-name').innerText = fullName;
    document.getElementById('nav-name').innerText = fullName;
    document.getElementById('nav-avatar').innerText = fullName.charAt(0);
    bootstrap.Modal.getInstance(document.getElementById('profile-modal')).hide();
    alert("Profile updated successfully!");
  } else {
    alert("Error updating profile: " + res.message);
  }
}

function logout() {
  if (confirm("Sign out of your account?")) {
    localStorage.removeItem('aspect_token');
    sessionToken = null;
    currentUser = null;
    showGuestState();
  }
}

function initStudentDashboard() {
  document.getElementById('guest-view').style.display = 'none';
  document.getElementById('student-main').style.display = 'block';

  const dropdown = document.getElementById('nav-user-dropdown');
  if (dropdown) dropdown.classList.remove('d-none');

  document.getElementById('profile-name').innerText = currentUser.fullName;
  document.getElementById('profile-meta').innerText = `Student ID: ${currentUser.studentId} | Section: ${currentUser.section}`;
  document.getElementById('nav-name').innerText = currentUser.fullName;
  document.getElementById('nav-id').innerText = `ID: ${currentUser.studentId}`;
  document.getElementById('nav-avatar').innerText = currentUser.fullName.charAt(0);

  loadStudentResults();
}

async function loadStudentResults() {
  const container = document.getElementById('results-container');
  container.innerHTML = `<div class="col-12 text-center py-5 text-secondary"><div class="spinner-border text-primary mb-3" style="width: 2.5rem; height: 2.5rem;"></div><br><span class="fw-semibold">Retrieving examination records...</span></div>`;

  try {
    const res = await callApi({ action: 'GET_STUDENT_RESULTS', sessionToken: sessionToken });
    if (res.success) {
      currentStudentResults = res.results;
      renderResults(currentStudentResults);
    } else {
      container.innerHTML = `<div class="col-12 alert alert-danger">${res.message}</div>`;
    }
  } catch (err) {
    container.innerHTML = `<div class="col-12 alert alert-danger">Connection error: ${err}</div>`;
  }
}

function renderResults(results) {
  const container = document.getElementById('results-container');
  container.innerHTML = "";
  document.getElementById('results-count').innerText = `${results.length} Recorded`;

  if (results.length === 0) {
    container.innerHTML = `
      <div class="col-12">
        <div class="card p-5 text-center border-dashed">
          <i class="bi bi-folder2-open display-4 text-body-tertiary mb-2"></i>
          <h6 class="fw-bold text-body-secondary">No Exam Scores Recorded Yet</h6>
          <p class="small text-body-secondary mb-0">Your exam records will populate here once evaluated.</p>
        </div>
      </div>`;
    return;
  }

  results.forEach(item => {
    const isPassed = item.status === 'PASSED';
    const hasImage = item.scannedImage && item.scannedImage.length > 50;
    
    const card = document.createElement('div');
    card.className = "col-md-6 col-lg-4";
    card.innerHTML = `
      <div class="card h-100 shadow-sm border">
        <div class="card-header bg-body border-bottom py-2.5 d-flex justify-content-between align-items-center">
          <span class="fw-bold font-monospace text-primary">${item.subjectCode}</span>
          <span class="badge ${isPassed ? 'bg-success' : 'bg-danger'}">${item.status}</span>
        </div>
        <div class="card-body pb-2">
          <h6 class="fw-bold mb-1">${item.subjectTitle}</h6>
          <small class="text-body-secondary d-block mb-3">Section: ${item.section} • Test Set: ${item.set}</small>

          <div class="row g-2 text-center mb-3">
            <div class="col-6">
              <div class="border rounded p-2 bg-body-tertiary">
                <span class="text-uppercase fw-bold text-body-secondary" style="font-size: 0.65rem;">Raw Score</span>
                <div class="fs-4 fw-bold">${item.rawScore} <small class="fs-6 text-secondary">/ ${item.totalPoints}</small></div>
              </div>
            </div>
            <div class="col-6">
              <div class="border rounded p-2 bg-primary-subtle border-primary-subtle">
                <span class="text-uppercase fw-bold text-primary" style="font-size: 0.65rem;">Score Rate</span>
                <div class="fs-4 fw-bold text-primary-emphasis">${item.percentage}</div>
              </div>
            </div>
          </div>
          
          <div class="d-flex justify-content-between align-items-center text-secondary small">
            <span><i class="bi bi-clock-history me-1"></i>${item.timestamp}</span>
            ${hasImage ? `<button class="btn btn-sm btn-outline-primary py-0" onclick="viewStudentSheet(${item.id})"><i class="bi bi-camera"></i> View Sheet</button>` : ''}
          </div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function viewStudentSheet(subId) {
  const item = currentStudentResults.find(r => r.id === subId);
  if (!item || !item.scannedImage) return;

  const canvas = document.getElementById('student-sheet-canvas');
  const ctx = canvas.getContext('2d');
  
  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    if (item.itemBreakdown) {
      drawValidationOverlays(ctx, item.itemBreakdown);
    }
    new bootstrap.Modal(document.getElementById('view-sheet-modal')).show();
  };
  img.src = "data:image/jpeg;base64," + item.scannedImage;
}

function drawValidationOverlays(ctx, itemBreakdown) {
  if (!itemBreakdown || !Array.isArray(itemBreakdown)) return;
  const isForm100 = itemBreakdown.length > 50;
  itemBreakdown.forEach(ib => {
    if (!ib.bubbles) return;
    ib.bubbles.forEach(b => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r || (isForm100 ? 4.8 : 5.8), 0, 2 * Math.PI);
      if (b.state === 'correct') {
        ctx.strokeStyle = '#28a745';
        ctx.fillStyle = 'rgba(40, 167, 69, 0.28)';
        ctx.lineWidth = 2.0;
        ctx.fill();
        ctx.stroke();
      } else if (b.state === 'wrong') {
        ctx.strokeStyle = '#dc3545';
        ctx.fillStyle = 'rgba(220, 53, 69, 0.28)';
        ctx.lineWidth = 2.0;
        ctx.fill();
        ctx.stroke();
      } else if (b.state === 'missed') {
        ctx.strokeStyle = '#ffc107';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }
      ctx.restore();
    });
  });
}