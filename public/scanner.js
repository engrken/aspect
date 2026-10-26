/**
 * ASPECT Engine — Scanner & Image Capture (Optimized for Server-Side OpenCV)
 */

let videoStream = null;
let currentCameraFacing = 'environment';
let lastScannedData = null;
let cachedWarpedData = null;
let lastCapturedDataUrl = null; // local-only; never written to the grade database
let scannerView = 'corrected';
let scannerRenderNonce = 0;
let priorStableCorners = null;
let awaitingSheetRemoval = false;
let missingSheetFrames = 0;

// Browser video frames are often much lower-resolution than native phone photos.
// Keep enough pixels for the printed answer bubbles and QR without huge uploads.
const MAX_CAPTURE_EDGE = 2560;
const CAPTURE_JPEG_QUALITY = 0.92;
// Run frequent lightweight probes, but capture only once geometry and detail
// are acceptable. Never impose an arbitrary autofocus countdown.
const PROBE_WIDTH = 640;
const AUTO_SCAN_INTERVAL_MS = 170;
const MAX_CORNER_DRIFT_PX = 6;
// A deliberately conservative low-detail guard; server-side OpenCV still
// performs the authoritative full-resolution blur check.
const MIN_DETAIL_EDGE_RATIO = 0.008;


let autoScanInterval = null;
let isScanningFrame = false;
let stableAlignmentCount = 0;
const REQUIRED_STABLE_FRAMES = 3;

let nativeBarcodeDetector = null;
if ('BarcodeDetector' in window) {
  try { nativeBarcodeDetector = new BarcodeDetector({ formats: ['qr_code'] }); }
  catch (error) { console.warn('Native QR detection unavailable:', error); }
}

function populateStudentSelect() {
  const sel = document.getElementById('scan-student-select');
  if (!sel) return;
  sel.innerHTML = '<option value="">Roster Selector...</option>' +
    enrolledStudentsList.map(s => `<option value="${s.studentId}">${s.fullName} (${s.studentId})</option>`).join('');
}

function onStudentSelectChange(val) {
  document.getElementById('scan-detected-id').value = val;
  matchAndDisplayStudent(val, false);
}

// Called by the A / B radio controls in teacher.html.
function onSetSelectorChange(set) {
  if (lastScannedData && lastScannedData.testSet !== set) {
    lastScannedData = null;
    const btn = document.getElementById('btn-save-scan');
    if (btn) btn.disabled = true;
    const grade = document.getElementById('scan-grade-display');
    if (grade) grade.innerText = 'Exam set changed. Retake the scan before saving.';
  }
}

function matchAndDisplayStudent(studentId, isQrVerified) {
  const card = document.getElementById('examinee-card');
  const avatar = document.getElementById('examinee-avatar');
  const nameEl = document.getElementById('examinee-name');
  const metaEl = document.getElementById('examinee-meta');
  const badge = document.getElementById('examinee-badge');
  const saveBtn = document.getElementById('btn-save-scan');

  if (!studentId) {
    if (card) card.className = 'p-2 mb-2 rounded border bg-light d-flex align-items-center gap-2';
    if (avatar) { avatar.className = 'rounded-circle bg-secondary text-white fw-bold d-flex align-items-center justify-content-center flex-shrink-0'; avatar.innerText = '?'; }
    if (nameEl) nameEl.innerText = 'No Student Identified';
    if (metaEl) metaEl.innerText = 'Scan QR code or choose from selector';
    if (badge) { badge.className = 'badge bg-secondary'; badge.innerText = 'PENDING'; }
    if (saveBtn) saveBtn.disabled = true;
    return;
  }

  const st = enrolledStudentsList.find(s => String(s.studentId).trim().toUpperCase() === String(studentId).trim().toUpperCase());

  if (st) {
    if (card) card.className = 'p-2 mb-2 rounded border border-success-subtle bg-success-subtle d-flex align-items-center gap-2';
    if (avatar) { avatar.className = 'rounded-circle bg-success text-white fw-bold d-flex align-items-center justify-content-center flex-shrink-0'; avatar.innerText = st.fullName.charAt(0).toUpperCase(); }
    if (nameEl) nameEl.innerText = st.fullName;
    if (metaEl) metaEl.innerText = `${st.studentId} • ${st.section || 'Class Roster'}`;
    if (badge) { badge.className = isQrVerified ? 'badge bg-success' : 'badge bg-primary'; badge.innerText = isQrVerified ? 'QR VERIFIED' : 'ROSTER MATCH'; }
  } else {
    if (card) card.className = 'p-2 mb-2 rounded border border-warning-subtle bg-warning-subtle d-flex align-items-center gap-2';
    if (avatar) { avatar.className = 'rounded-circle bg-warning text-dark fw-bold d-flex align-items-center justify-content-center flex-shrink-0'; avatar.innerText = 'ID'; }
    if (nameEl) nameEl.innerText = `Student ID: ${studentId}`;
    if (metaEl) metaEl.innerText = 'Auto-detected from sheet';
    if (badge) { badge.className = 'badge bg-warning text-dark'; badge.innerText = isQrVerified ? 'QR DETECTED' : 'ID SET'; }
  }

  document.getElementById('scan-detected-id').value = studentId;
  const sel = document.getElementById('scan-student-select');
  if (sel && st) sel.value = st.studentId;

  if (lastScannedData) {
    lastScannedData.studentId = studentId;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function initScanner() {
  const video = document.getElementById('scanner-video');
  stopAutoScanLoop();
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
    videoStream = null;
  }

  if (enrolledStudentsList.length === 0 && activeClassId) {
    if (typeof loadSubjectEnrollment === 'function') await loadSubjectEnrollment();
  }
  populateStudentSelect();

  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Browser camera is unavailable. Use the Phone Camera button to take a photo instead.');
    return;
  }

  try {
    // Ideal, not minimum/maximum: do not force phones into a low-resolution
    // camera stream or a distorted aspect ratio.
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: currentCameraFacing },
          width: { ideal: 2560 },
          height: { ideal: 1920 }
        },
        audio: false
      });
    } catch (highResError) {
      // Some camera drivers reject the requested format; use device default.
      videoStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: currentCameraFacing } }, audio: false
      });
    }

    video.srcObject = videoStream;
    await video.play();
    const track = videoStream.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === 'function' &&
        typeof track.applyConstraints === 'function') {
      try {
        const caps = track.getCapabilities();
        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
          await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
        }
      } catch (err) { console.info('Continuous autofocus not supported by this camera.'); }
    }
    const info = document.getElementById('scanner-camera-info');
    if (info) info.innerText = `Live camera: ${video.videoWidth} × ${video.videoHeight}. Keep the phone steady and parallel to the page.`;
    resetToLiveCamera();
  } catch (err) {
    alert('Cannot open the camera: ' + (err?.message || err) + '. Try Phone Camera instead.');
  }
}

function restartCamera() {
  currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
  initScanner();
}

function resetToLiveCamera(requireRemoval = false) {
  // After saving a grade, the same sheet must leave the viewfinder before
  // a fresh automatic scan can be armed. Manual capture is never blocked.
  awaitingSheetRemoval = requireRemoval;
  missingSheetFrames = 0;
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');
  const overlay = document.getElementById('viewfinder-overlay');
  const retakeBtn = document.getElementById('btn-retake');
  const saveBtn = document.getElementById('btn-save-scan');

  if (video) video.style.display = 'block';
  if (canvas) canvas.style.display = 'none';
  if (overlay) overlay.style.display = 'block';
  if (retakeBtn) retakeBtn.style.display = 'none';
  const toggle = document.getElementById('btn-toggle-scan-photo');
  if (toggle) toggle.style.display = 'none';
  const capture = document.getElementById('btn-capture');
  if (capture) capture.disabled = false;
  if (saveBtn) saveBtn.disabled = true;

  document.getElementById('scan-score-display').innerText = '0 / 0';
  document.getElementById('scan-grade-display').innerText = 'Ready for scan';

  const breakdownContainer = document.getElementById('ai-breakdown-container');
  if (breakdownContainer) breakdownContainer.innerHTML = '<span class="text-muted d-block text-center py-2">No scan data yet.</span>';

  lastScannedData = null;
  cachedWarpedData = null;
  lastCapturedDataUrl = null;
  scannerRenderNonce++;
  scannerView = 'corrected';
  const info = document.getElementById('scanner-camera-info');
  if (info && video?.videoWidth) info.innerText =
    `Live camera: ${video.videoWidth} × ${video.videoHeight}. Hold the phone parallel and steady.`;
  updateTargetUI(false);
  startAutoScanLoop();
}

function updateTargetUI(isLocked, instruction = '') {
  const frame = document.getElementById('viewfinder-frame');
  const brackets = document.querySelectorAll('.target-bracket');
  const label = document.getElementById('align-instruction');
  const color = isLocked ? '#198754' : '#0d6efd';

  if (frame) frame.style.borderColor = isLocked ? 'rgba(25, 135, 84, 0.85)' : 'rgba(255,255,255,0.35)';
  brackets.forEach(b => b.style.borderColor = color);

  if (label) {
    if (isLocked) {
      label.innerText = `Keep steady · ${stableAlignmentCount}/${REQUIRED_STABLE_FRAMES}`;
      label.style.color = '#20c997';
    } else {
      label.innerText = instruction || "Fit all 4 outer corner black squares inside the frame";
      label.style.color = '#ffffff';
    }
  }
}

/**
 * Approximate detail from the live preview without transferring the full
 * camera frame. A low edge ratio indicates a soft / poorly-lit picture.
 * This does not replace the server-side blur validation on the captured JPEG.
 */
function estimateProbeDetail(imgData, W, H) {
  const data = imgData.data;
  let edges = 0, samples = 0;
  const endX = Math.floor(W * 0.84);
  const endY = Math.floor(H * 0.84);
  const luminanceAt = (x, y) => {
    const i = (y * W + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  for (let y = Math.floor(H * 0.16); y < endY; y += 4) {
    for (let x = Math.floor(W * 0.16); x < endX; x += 4) {
      const value = luminanceAt(x, y);
      if (Math.abs(value - luminanceAt(x + 2, y)) +
          Math.abs(value - luminanceAt(x, y + 2)) > 45) edges++;
      samples++;
    }
  }
  return samples ? edges / samples : 0;
}

function startAutoScanLoop() {
  stopAutoScanLoop();
  stableAlignmentCount = 0;
  priorStableCorners = null;

  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = PROBE_WIDTH;
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

  autoScanInterval = setInterval(async () => {
    const video = document.getElementById('scanner-video');
    if (!video || !video.videoWidth || video.readyState < 2 ||
        video.style.display === 'none' || isScanningFrame || document.hidden) return;
    const probeH = Math.round(PROBE_WIDTH * video.videoHeight / video.videoWidth);
    if (probeCanvas.height !== probeH) probeCanvas.height = probeH;

    probeCtx.drawImage(video, 0, 0, PROBE_WIDTH, probeH);
    const probeImg = probeCtx.getImageData(0, 0, PROBE_WIDTH, probeH);
    const corners = findFourCornersRobust(probeImg, PROBE_WIDTH, probeH);

    // A previously submitted sheet must leave the frame before we rearm.
    // This prevents capturing the same paper again while the phone is still
    // pointed at it. Re-arm after two absent-marker probes.
    if (awaitingSheetRemoval) {
      missingSheetFrames = corners ? 0 : missingSheetFrames + 1;
      if (missingSheetFrames >= 2) {
        awaitingSheetRemoval = false;
        missingSheetFrames = 0;
        updateTargetUI(false, 'Next sheet: align all four black corner squares');
      } else {
        updateTargetUI(false, 'Remove the previous sheet before continuing');
      }
      return;
    }

    if (!corners) {
      stableAlignmentCount = 0;
      priorStableCorners = null;
      updateTargetUI(false);
      return;
    }

    if (estimateProbeDetail(probeImg, PROBE_WIDTH, probeH) < MIN_DETAIL_EDGE_RATIO) {
      stableAlignmentCount = 0;
      priorStableCorners = null;
      updateTargetUI(false, 'Improve focus or lighting before scanning');
      return;
    }

    const stable = priorStableCorners && ['tl','tr','bl','br'].every(k =>
      Math.hypot(corners[k].x - priorStableCorners[k].x,
                 corners[k].y - priorStableCorners[k].y) < MAX_CORNER_DRIFT_PX);
    stableAlignmentCount = stable ? stableAlignmentCount + 1 : 1;
    priorStableCorners = corners;
    updateTargetUI(true);

    if (stableAlignmentCount >= REQUIRED_STABLE_FRAMES) {
      stopAutoScanLoop();
      if (navigator.vibrate) navigator.vibrate(60);
      try {
        await processCameraFrame();
      } catch (err) {
        console.error('Automatic scan failed:', err);
        resetToLiveCamera();
      }
    }
  }, AUTO_SCAN_INTERVAL_MS);
}

function stopAutoScanLoop() {
  if (autoScanInterval) {
    clearInterval(autoScanInterval);
    autoScanInterval = null;
  }
}

function findFourCornersRobust(imgData, W, H) {
  const data = imgData.data;

  let minLum = 255, maxLum = 0;
  const marginX = Math.floor(W * 0.05);
  const marginY = Math.floor(H * 0.05);
  for (let y = marginY; y < H - marginY; y += 8) {
    for (let x = marginX; x < W - marginX; x += 8) {
      const idx = (y * W + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }
  }

  if (maxLum - minLum < 35) return null;
  const darkThreshold = minLum + (maxLum - minLum) * 0.30;

  const visited = new Uint8Array(W * H);
  const candidates = [];
  const minSize = 5, maxSize = Math.max(36, Math.floor(Math.min(W, H) * 0.09));
  const qX = new Int32Array(3000), qY = new Int32Array(3000);
  const startY = 6, endY = H - 6, startX = 6, endX = W - 6;

  for (let sy = startY; sy < endY; sy += 2) {
    for (let sx = startX; sx < endX; sx += 2) {
      const vIdx = sy * W + sx;
      if (visited[vIdx]) continue;

      const idx = vIdx * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      if (lum >= darkThreshold) { visited[vIdx] = 1; continue; }

      let head = 0, tail = 0;
      qX[tail] = sx; qY[tail] = sy; tail++;
      visited[vIdx] = 1;

      let bMinX = sx, bMaxX = sx, bMinY = sy, bMaxY = sy;
      let sumX = 0, sumY = 0, count = 0;

      while (head < tail) {
        const cx = qX[head], cy = qY[head];
        head++; count++;
        sumX += cx; sumY += cy;

        if (cx < bMinX) bMinX = cx;
        if (cx > bMaxX) bMaxX = cx;
        if (cy < bMinY) bMinY = cy;
        if (cy > bMaxY) bMaxY = cy;

        const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (let i = 0; i < 4; i++) {
          const nx = neighbors[i][0], ny = neighbors[i][1];
          if (nx >= startX && nx < endX && ny >= startY && ny < endY) {
            const nVidx = ny * W + nx;
            if (!visited[nVidx]) {
              visited[nVidx] = 1;
              const nIdx = nVidx * 4;
              const nLum = 0.299 * data[nIdx] + 0.587 * data[nIdx + 1] + 0.114 * data[nIdx + 2];
              if (nLum < darkThreshold && tail < 2990) {
                qX[tail] = nx; qY[tail] = ny; tail++;
              }
            }
          }
        }
      }

      const bw = bMaxX - bMinX + 1;
      const bh = bMaxY - bMinY + 1;
      if (bw >= minSize && bw <= maxSize && bh >= minSize && bh <= maxSize) {
        const aspect = bw / bh;
        if (aspect >= 0.68 && aspect <= 1.45) {
          const areaRatio = count / (bw * bh);
          if (areaRatio >= 0.65) {
            candidates.push({ x: sumX / count, y: sumY / count });
          }
        }
      }
    }
  }

  if (candidates.length < 4) return null;

  const tlList = candidates.filter(c => c.x < W * 0.38 && c.y < H * 0.38);
  const trList = candidates.filter(c => c.x > W * 0.62 && c.y < H * 0.38);
  const blList = candidates.filter(c => c.x < W * 0.38 && c.y > H * 0.62);
  const brList = candidates.filter(c => c.x > W * 0.62 && c.y > H * 0.62);

  if (!tlList.length || !trList.length || !blList.length || !brList.length) return null;

  tlList.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  trList.sort((a, b) => (b.x - b.y) - (a.x - a.y));
  blList.sort((a, b) => (a.x - a.y) - (b.x - b.y));
  brList.sort((a, b) => (b.x + b.y) - (a.x + a.y));

  const tl = tlList[0], tr = trList[0], bl = blList[0], br = brList[0];
  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const botW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

  if (topW < W * 0.12 || botW < W * 0.12 || leftH < H * 0.24 || rightH < H * 0.24) return null;
  if (Math.abs(topW - botW) / Math.max(topW, botW) > 0.18) return null;
  if (Math.abs(leftH - rightH) / Math.max(leftH, rightH) > 0.18) return null;

  return { tl, tr, bl, br };
}

/** Decode any native photo with orientation handled by the browser. */
async function blobToDrawable(blob) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (err) { /* Safari and older browsers accept fewer bitmap options. */ }
    try { return await createImageBitmap(blob); } catch (err) {}
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Phone could not decode this picture. Try a JPEG photograph.'));
      img.src = url;
    });
  } finally {
    // The decoded image is safe to draw after load, even when URL is revoked.
    URL.revokeObjectURL(url);
  }
}

function drawableToCanvas(drawable) {
  const sourceW = drawable.videoWidth || drawable.naturalWidth || drawable.width;
  const sourceH = drawable.videoHeight || drawable.naturalHeight || drawable.height;
  if (!sourceW || !sourceH) throw new Error('Camera returned an empty image.');
  const scale = Math.min(1, MAX_CAPTURE_EDGE / Math.max(sourceW, sourceH));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sourceW * scale));
  c.height = Math.max(1, Math.round(sourceH * scale));
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Cannot create capture canvas.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(drawable, 0, 0, c.width, c.height);
  return c;
}

async function acquireSharpCameraFrame(video) {
  const track = videoStream?.getVideoTracks()?.[0];
  if (track && typeof ImageCapture !== 'undefined') {
    try {
      const camera = new ImageCapture(track);
      const blob = await camera.takePhoto();
      if (blob?.size) {
        const bitmap = await blobToDrawable(blob);
        try { return drawableToCanvas(bitmap); }
        finally { if (typeof bitmap.close === 'function') bitmap.close(); }
      }
    } catch (err) {
      console.warn('High-resolution still photo unavailable; using the live frame.', err);
    }
  }
  // Unlike the old implementation, retain the full video frame, up to 2560px.
  return drawableToCanvas(video);
}

async function onNativePhotoSelected(input) {
  const file = input.files?.[0];
  input.value = ''; // allow the same file to be selected again after a retake
  if (!file) {
    if (!lastScannedData) startAutoScanLoop();
    return;
  }
  try {
    const bitmap = await blobToDrawable(file);
    let canvas;
    try { canvas = drawableToCanvas(bitmap); }
    finally { if (typeof bitmap.close === 'function') bitmap.close(); }
    await processCameraFrame(null, canvas);
  } catch (error) {
    alert('Could not read the photo: ' + (error?.message || error));
    resetToLiveCamera();
  }
}

function toggleScanPhoto() {
  if (!lastCapturedDataUrl || !cachedWarpedData) return;
  scannerView = scannerView === 'corrected' ? 'original' : 'corrected';
  renderScanPreview();
}

function renderScanPreview() {
  const canvas = document.getElementById('scanner-canvas');
  const toggle = document.getElementById('btn-toggle-scan-photo');
  if (!canvas) return;
  const original = scannerView === 'original';
  const source = original ? lastCapturedDataUrl : cachedWarpedData;
  if (!source) return;
  const sequence = ++scannerRenderNonce;
  const img = new Image();
  img.onload = () => {
    if (sequence !== scannerRenderNonce) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if (!original && lastScannedData?.itemBreakdown) {
      ctx.save();
      // OMR bubbles are in 400px canonical coordinates, while the sharp
      // server preview is now larger. Scale only the colored overlays.
      const sheetH = lastScannedData.itemBreakdown.length > 50 ? 570 : 450;
      ctx.scale(img.naturalWidth / 400, img.naturalHeight / sheetH);
      drawValidationOverlays(ctx, lastScannedData.itemBreakdown);
      ctx.restore();
    }
  };
  img.onerror = () => console.error('Cannot render the scanner preview.');
  img.src = source;
  if (toggle) {
    toggle.style.display = 'inline-block';
    toggle.innerText = original ? 'View Graded Sheet' : 'View Original Photo';
  }
}

async function decodeStudentQRMultiStage(videoElement, rawCanvas) {
  if (nativeBarcodeDetector) {
    try {
      const barcodes = await nativeBarcodeDetector.detect(rawCanvas || videoElement);
      if (barcodes && barcodes.length > 0) return cleanQrPayload(barcodes[0].rawValue);
    } catch (e) {}
  }
  if (typeof jsQR !== "undefined" && rawCanvas) {
    const rx = Math.floor(rawCanvas.width * 0.45), ry = 0, rw = rawCanvas.width - rx, rh = Math.floor(rawCanvas.height * 0.45);
    // Scale the QR search image to keep browser decoding responsive even
    // when the native phone camera supplies a 12MP image.
    const fit = Math.min(1, 1000 / Math.max(rw, rh));
    const qw = Math.max(1, Math.round(rw * fit));
    const qh = Math.max(1, Math.round(rh * fit));
    const qrCropCanvas = document.createElement('canvas');
    qrCropCanvas.width = qw; qrCropCanvas.height = qh;
    const qrCtx = qrCropCanvas.getContext('2d');
    qrCtx.drawImage(rawCanvas, rx, ry, rw, rh, 0, 0, qw, qh);
    let code = jsQR(qrCtx.getImageData(0, 0, qw, qh).data, qw, qh, { inversionAttempts: "attemptBoth" });
    if (code && code.data) return cleanQrPayload(code.data);
  }
  return null;
}

function cleanQrPayload(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (cleaned.startsWith("ASPECT|")) {
    const parts = cleaned.split("|");
    return { studentId: (parts[2] || parts[1] || "").trim(), formType: (parts[3] || "F50").trim() };
  }
  return { studentId: cleaned, formType: 'UNKNOWN' };
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
        ctx.strokeStyle = '#28a745'; ctx.fillStyle = 'rgba(40, 167, 69, 0.28)'; ctx.lineWidth = 2.0; ctx.fill(); ctx.stroke();
      } else if (b.state === 'wrong') {
        ctx.strokeStyle = '#dc3545'; ctx.fillStyle = 'rgba(220, 53, 69, 0.28)'; ctx.lineWidth = 2.0; ctx.fill(); ctx.stroke();
      } else if (b.state === 'missed') {
        ctx.strokeStyle = '#ffc107'; ctx.lineWidth = 1.8; ctx.stroke();
      }
      ctx.restore();
    });
  });
}

async function processCameraFrame(preDetectedCorners = null, suppliedCanvas = null) {
  if (isScanningFrame) return;
  isScanningFrame = true;
  stopAutoScanLoop();

  const video = document.getElementById('scanner-video');
  const displayCanvas = document.getElementById('scanner-canvas');
  const btn = document.getElementById('btn-capture');
  btn.disabled = true;
  document.getElementById('scan-grade-display').innerHTML =
    '<span class="spinner-border spinner-border-sm text-primary me-2"></span> Capturing & evaluating...';

  let rawCanvas, activeStudentId, activeSet, compressedBase64, qrResult;
  try {
    if (!suppliedCanvas && (!video.videoWidth || video.readyState < 2)) {
      throw new Error('Camera is not ready. Use Phone Camera for a sharper still photo.');
    }
    rawCanvas = suppliedCanvas || await acquireSharpCameraFrame(video);
    // Store exactly the pixels we send to OpenCV so staff can review
    // the original photograph as well as the perspective-corrected preview.
    compressedBase64 = rawCanvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY);
    if (compressedBase64 === 'data:,') throw new Error('Image encoding failed.');
    lastCapturedDataUrl = compressedBase64;
    activeStudentId = document.getElementById('scan-detected-id').value.trim();
    qrResult = await decodeStudentQRMultiStage(suppliedCanvas ? null : video, rawCanvas);
    if (qrResult?.studentId) {
      activeStudentId = qrResult.studentId;
      matchAndDisplayStudent(activeStudentId, true);
    }
    activeSet = document.querySelector('input[name="scan_set"]:checked')?.value || 'A';
  } catch (err) {
    btn.disabled = false;
    isScanningFrame = false;
    alert('Capture error: ' + (err?.message || err));
    resetToLiveCamera();
    return;
  }

  // 4. Submit the full-detail JPEG to OpenCV.
  let res;
  try {
    res = await callApi({
      action: 'AI_VISION_GRADE',
      sessionToken,
      classId: activeClassId,
      studentId: activeStudentId,
      testSet: activeSet,
      base64Image: compressedBase64,
      items: builderItems
    });
  } catch (error) {
    btn.disabled = false;
    isScanningFrame = false;
    alert('Scan connection error: ' + (error?.message || String(error)));
    resetToLiveCamera();
    return;
  }

  btn.disabled = false;
  isScanningFrame = false;

  if (!res.success) {
    alert("Grading Error: " + res.message);
    resetToLiveCamera();
    return;
  }

  // 5. Render full-detail rectified preview, or toggle to original photo.
  video.style.display = 'none';
  displayCanvas.style.display = 'block';
  document.getElementById('viewfinder-overlay').style.display = 'none';
  document.getElementById('btn-retake').style.display = 'inline-block';
  cachedWarpedData = res.warpedBase64 ? 'data:image/jpeg;base64,' + res.warpedBase64 : null;
  scannerView = 'corrected';

  const gradedSet = res.detectedTestSet || activeSet;
  const gradedSetRadio = document.querySelector(`input[name="scan_set"][value="${gradedSet}"]`);
  if (gradedSetRadio) gradedSetRadio.checked = true;
  if (res.studentId) {
    const qrMatches = !!qrResult && String(qrResult.studentId).toUpperCase() === String(res.studentId).toUpperCase();
    matchAndDisplayStudent(res.studentId, qrMatches);
  }

  document.getElementById('scan-score-display').innerText = `${res.rawScore} / ${res.totalPoints}`;
  document.getElementById('scan-grade-display').innerHTML = `
    <div class="d-flex align-items-center justify-content-center gap-2 mb-1">
      <span class="badge ${res.isPassed ? 'bg-success' : 'bg-danger'} fs-6">${res.status}</span>
      <span class="fw-bold fs-5">${res.percentage}%</span>
    </div>
  `;

  const breakdownContainer = document.getElementById('ai-breakdown-container');
  if (breakdownContainer && res.itemBreakdown) {
    let html = `<table class="table table-sm table-borderless mb-0" style="font-size: 0.73rem;">
      <thead class="table-light sticky-top"><tr><th>Item</th><th>Mark</th><th>Key</th><th>Result</th></tr></thead><tbody>`;
    res.itemBreakdown.forEach(ib => {
      html += `<tr>
        <td>#${ib.itemNo}</td>
        <td class="fw-bold">${ib.studentAnswer || '-'}</td>
        <td class="text-primary fw-bold">${ib.correctAnswer}</td>
        <td class="${ib.isCorrect ? 'text-success fw-bold' : 'text-danger fw-bold'}">
          <i class="bi bi-${ib.isCorrect ? 'check-circle-fill' : 'x-circle-fill'}"></i>
        </td>
      </tr>`;
    });
    html += `</tbody></table>`;
    breakdownContainer.innerHTML = html;
  }

  lastScannedData = {
    classId: activeClassId,
    studentId: res.studentId || activeStudentId,
    testSet: gradedSet,
    answers: res.answers,
    rawScore: res.rawScore,
    totalPoints: res.totalPoints,
    percentage: res.percentage,
    isPassed: res.isPassed,
    warpedBase64: res.warpedBase64,
    itemBreakdown: res.itemBreakdown
  };

  renderScanPreview();
  const cameraInfo = document.getElementById('scanner-camera-info');
  if (cameraInfo) cameraInfo.innerText =
    `Captured: ${rawCanvas.width} × ${rawCanvas.height} · Graded sheet aligned by OpenCV. Review both views before saving.`;
  if (lastScannedData.studentId) {
    document.getElementById('btn-save-scan').disabled = false;
  }
}

async function submitScannedResult() {
  if (!lastScannedData) return;
  const studentId = document.getElementById('scan-detected-id').value.trim();
  if (!studentId) return alert("Select or scan an examinee before saving.");

  const btn = document.getElementById('btn-save-scan');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm"></span> Recording Grade...`;

  try {
    const res = await callApi({
      action: 'SCANNER_SUBMIT',
      sessionToken,
      classId: lastScannedData.classId,
      studentId: studentId,
      testSet: lastScannedData.testSet,
      answers: lastScannedData.answers,
      items: builderItems,
      warpedBase64: lastScannedData.warpedBase64,
      itemBreakdown: lastScannedData.itemBreakdown
    });

    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Save Grade to Roster`;

    if (res.success) {
      document.getElementById('scan-detected-id').value = "";
      document.getElementById('scan-student-select').value = "";
      matchAndDisplayStudent('', false);
      resetToLiveCamera(true);
    } else {
      alert("Submission Error: " + res.message);
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Save Grade to Roster`;
    alert("Connection error: " + err);
  }
}