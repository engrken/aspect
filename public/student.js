/**
 * API Controller via Vercel Serverless Edge
 */
const API_BASE_URL = window.ASPECT_CONFIG?.API_URL || '/api';



let currentUser = null;
let sessionToken = localStorage.getItem('aspect_token') || null;
let authModal = null;

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

function openAuthModal() {
  showInputStep();
  clearAuthAlert();
  if (authModal) authModal.show();
}

function showOtpStep(studentId) {
  document.getElementById('step-inputs').classList.add('d-none');
  document.getElementById('step-otp').classList.remove('d-none');
  document.getElementById('modal-subtext').innerText = "Enter the 6-digit code to complete verification.";
  const idBadge = document.getElementById('otp-id-badge');
  if (idBadge) idBadge.innerText = `ID: ${studentId || document.getElementById('auth-id').value.trim()}`;
  const otpInput = document.getElementById('auth-otp');
  otpInput.value = "";
  setTimeout(() => otpInput.focus(), 150);
}

function showDirectOtpPrompt() {
  const id = document.getElementById('auth-id').value.trim();
  if (!id) {
    setAuthAlert('Please enter your ID Number first.');
    document.getElementById('auth-id').focus();
    return;
  }
  clearAuthAlert();
  showOtpStep(id);
}

function showInputStep() {
  document.getElementById('step-otp').classList.add('d-none');
  document.getElementById('step-inputs').classList.remove('d-none');
  document.getElementById('modal-subtext').innerText = "Enter your Student or Faculty ID number.";
  clearAuthAlert();
  const idInput = document.getElementById('auth-id');
  setTimeout(() => idInput.focus(), 150);
}

function setAuthAlert(message, type = 'danger') {
  const el = document.getElementById('auth-alert');
  el.className = `alert alert-${type} py-1.5 px-2 small mb-3`;
  el.innerText = message;
  el.classList.remove('d-none');
}

function clearAuthAlert() {
  const el = document.getElementById('auth-alert');
  el.classList.add('d-none');
  el.innerText = '';
}

function showGuestState() {
  document.getElementById('guest-view').style.display = 'block';
  document.getElementById('student-main').style.display = 'none';
  const dropdown = document.getElementById('nav-user-dropdown');
  if (dropdown) dropdown.classList.add('d-none');
}

window.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('aspect_theme') || 'light';
  document.documentElement.setAttribute('data-bs-theme', savedTheme);
  const modalEl = document.getElementById('auth-modal');
  if (modalEl) authModal = new bootstrap.Modal(modalEl);

  document.getElementById('auth-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); requestOTP(); }
  });
  document.getElementById('auth-otp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); verifyOTP(); }
  });

  if (sessionToken) {
    callApi({ action: 'VALIDATE_SESSION', sessionToken: sessionToken })
      .then(res => {
        if (res.valid) {
          if (res.user.role === 'TEACHER') {
            window.location.href = 'teacher.html';
            return;
          }
          currentUser = res.user;
          initStudentDashboard();
        } else {
          localStorage.removeItem('aspect_token');
          sessionToken = null;
          showGuestState();
        }
      })
      .catch(() => showGuestState());
  } else {
    showGuestState();
  }
});

async function requestOTP() {
  const id = document.getElementById('auth-id').value.trim();
  if (!id) return setAuthAlert('Please enter your Student or Faculty ID.');

  clearAuthAlert();
  const btn = document.getElementById('btn-otp');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Checking ID...`;

  try {
    const res = await callApi({ action: 'SEND_OTP', studentId: id });
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-arrow-right-circle me-1"></i> Continue`;

    if (res.success) {
      showOtpStep(id);
      if (res.devOtp) setAuthAlert(`Code generated: ${res.devOtp}`, 'info');
      else if (res.message) setAuthAlert(res.message, 'success');
    } else {
      setAuthAlert(res.message || `ID "${id}" not found.`);
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-arrow-right-circle me-1"></i> Continue`;
    setAuthAlert('Connection error while contacting server.');
  }
}

async function verifyOTP() {
  const id = document.getElementById('auth-id').value.trim();
  const otp = document.getElementById('auth-otp').value.trim();
  if (!otp) return setAuthAlert('Please enter the 6-digit OTP code.');

  clearAuthAlert();
  const btn = document.getElementById('btn-verify');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Verifying...`;

  try {
    const res = await callApi({ action: 'VERIFY_OTP', studentId: id, otp: otp });
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-check-circle me-1"></i> Verify & Sign In`;

    if (res.success) {
      sessionToken = res.sessionToken;
      currentUser = res.user;
      localStorage.setItem('aspect_token', sessionToken);
      if (authModal) authModal.hide();

      if (currentUser.role === 'TEACHER') {
        window.location.href = 'teacher.html';
      } else {
        initStudentDashboard();
      }
    } else {
      setAuthAlert(res.message || 'Invalid or expired OTP code.');
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-check-circle me-1"></i> Verify & Sign In`;
    setAuthAlert('Verification error: ' + err);
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
  container.innerHTML = `<div class="col-12 text-center py-5 text-secondary"><div class="spinner-border text-primary spinner-border-sm mb-2"></div><br>Retrieving exam records...</div>`;

  try {
    const res = await callApi({ action: 'GET_STUDENT_RESULTS', sessionToken: sessionToken });
    if (res.success) {
      renderResults(res.results);
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
    const card = document.createElement('div');
    card.className = "col-md-6 col-lg-4";
    card.innerHTML = `
      <div class="card h-100 shadow-sm border">
        <div class="card-header bg-body border-bottom py-2.5 d-flex justify-content-between align-items-center">
          <span class="fw-bold font-monospace text-primary">${item.subjectCode}</span>
          <span class="badge ${isPassed ? 'bg-success' : 'bg-danger'}">${item.status}</span>
        </div>
        <div class="card-body">
          <h6 class="fw-bold mb-1">${item.subjectTitle}</h6>
          <small class="text-body-secondary d-block mb-3">Section: ${item.section} • Test Set: ${item.set}</small>

          <div class="row g-2 text-center mb-3">
            <div class="col-6">
              <div class="border rounded p-2 bg-body-tertiary">
                <span class="text-uppercase fw-bold text-body-secondary" style="font-size: 0.65rem;">Raw Score</span>
                <div class="fs-4 fw-bold">${item.rawScore} <small class="fs-6 text-secondary">/ ${item.totalPoints}</small></div>
                <div class="small fw-semibold text-secondary">Points Earned</div>
              </div>
            </div>
            <div class="col-6">
              <div class="border rounded p-2 bg-primary-subtle border-primary-subtle">
                <span class="text-uppercase fw-bold text-primary" style="font-size: 0.65rem;">Score Rate</span>
                <div class="fs-4 fw-bold text-primary-emphasis">${item.percentage}</div>
                <div class="small fw-semibold text-primary">Percentage</div>
              </div>
            </div>
          </div>

          <div class="d-flex justify-content-between align-items-center text-secondary small">
            <span><i class="bi bi-clock-history me-1"></i>Scanned:</span>
            <span class="font-monospace">${item.timestamp}</span>
          </div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}