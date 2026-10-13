/**
 * ASPECT Engine — Optical Mark Recognition & Vision Pipeline
 * Dual-Tier Registration: Piecewise 50-Item Half-Sheet & 100-Item Full Sheet
 * Backed by Python/FastAPI OpenCV Serverless Engine
 */

let videoStream = null;
let currentCameraFacing = 'environment';
let lastScannedData = null;
let cachedWarpedData = null;

let autoScanInterval = null;
let isScanningFrame = false;
let stableAlignmentCount = 0;
const REQUIRED_STABLE_FRAMES = 2;

const nativeBarcodeDetector = ('BarcodeDetector' in window) 
  ? new BarcodeDetector({ formats: ['qr_code'] }) 
  : null;

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
    if (metaEl) metaEl.innerText = 'Unlisted in current section roster';
    if (badge) { badge.className = 'badge bg-warning text-dark'; badge.innerText = isQrVerified ? 'QR DETECTED' : 'UNLISTED'; }
  }

  document.getElementById('scan-detected-id').value = studentId;
  const sel = document.getElementById('scan-student-select');
  if (sel) sel.value = studentId;

  if (lastScannedData) {
    lastScannedData.studentId = studentId;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function initScanner() {
  const video = document.getElementById('scanner-video');
  if (videoStream) {
    videoStream.getTracks().forEach(track => track.stop());
  }

  if (enrolledStudentsList.length === 0 && activeClassId) {
    await loadSubjectEnrollment();
  }
  populateStudentSelect();

  try {
    videoStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: currentCameraFacing },
        width: { min: 640, ideal: 1280, max: 1920 },
        height: { min: 480, ideal: 720, max: 1080 }
      },
      audio: false
    });
    video.srcObject = videoStream;
    resetToLiveCamera();
  } catch (err) {
    alert("Camera permission denied: " + err);
  }
}

function restartCamera() {
  currentCameraFacing = currentCameraFacing === 'environment' ? 'user' : 'environment';
  initScanner();
}

function resetToLiveCamera() {
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');
  const overlay = document.getElementById('viewfinder-overlay');
  const retakeBtn = document.getElementById('btn-retake');
  const saveBtn = document.getElementById('btn-save-scan');

  if (video) video.style.display = 'block';
  if (canvas) canvas.style.display = 'none';
  if (overlay) overlay.style.display = 'block';
  if (retakeBtn) retakeBtn.style.display = 'none';
  if (saveBtn) saveBtn.disabled = true;

  document.getElementById('scan-score-display').innerText = '0 / 0';
  document.getElementById('scan-grade-display').innerText = 'Ready for scan';

  const breakdownContainer = document.getElementById('ai-breakdown-container');
  if (breakdownContainer) breakdownContainer.innerHTML = '<span class="text-muted d-block text-center py-2">No scan data yet.</span>';

  lastScannedData = null;
  cachedWarpedData = null;
  matchAndDisplayStudent('', false);
  updateTargetUI(false);
  startAutoScanLoop();
}

function updateTargetUI(isLocked) {
  const frame = document.getElementById('viewfinder-frame');
  const brackets = document.querySelectorAll('.target-bracket');
  const label = document.getElementById('align-instruction');
  const color = isLocked ? '#198754' : '#0d6efd';

  if (frame) frame.style.borderColor = isLocked ? 'rgba(25, 135, 84, 0.8)' : 'rgba(255,255,255,0.35)';
  brackets.forEach(b => b.style.borderColor = color);

  if (label) {
    if (isLocked) {
      label.innerText = `Aligned! Hold steady (${stableAlignmentCount}/${REQUIRED_STABLE_FRAMES})...`;
      label.style.color = '#20c997';
    } else {
      label.innerText = "Point camera at the answer sheet";
      label.style.color = '#ffffff';
    }
  }
}

function startAutoScanLoop() {
  stopAutoScanLoop();
  stableAlignmentCount = 0;

  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 640;
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true });

  autoScanInterval = setInterval(async () => {
    const video = document.getElementById('scanner-video');
    if (!video || !video.videoWidth || video.style.display === 'none' || isScanningFrame) return;

    const probeH = Math.round(640 * (video.videoHeight / video.videoWidth));
    if (probeCanvas.height !== probeH) probeCanvas.height = probeH;

    probeCtx.drawImage(video, 0, 0, 640, probeH);
    const probeImg = probeCtx.getImageData(0, 0, 640, probeH);
    
    const corners = findFourCornersRobust(probeImg, 640, probeH);

    if (corners) {
      stableAlignmentCount++;
      updateTargetUI(true);
      if (stableAlignmentCount >= REQUIRED_STABLE_FRAMES) {
        isScanningFrame = true;
        stopAutoScanLoop();
        if (navigator.vibrate) navigator.vibrate(60);
        try {
          await processCameraFrame();
        } catch (err) {
          console.error("Auto-scan execution error:", err);
          resetToLiveCamera();
        } finally {
          isScanningFrame = false;
        }
      }
    } else {
      stableAlignmentCount = 0;
      updateTargetUI(false);
    }
  }, 140);
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
  for (let y = 0; y < H; y += 8) {
    for (let x = 0; x < W; x += 8) {
      const idx = (y * W + x) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
      if (lum < minLum) minLum = lum;
      if (lum > maxLum) maxLum = lum;
    }
  }
  
  if (maxLum - minLum < 40) return null;
  const darkThreshold = minLum + (maxLum - minLum) * 0.40;
  
  const visited = new Uint8Array(W * H);
  const candidates = [];
  const minDim = Math.min(W, H);
  const minSize = Math.max(4, Math.floor(minDim * 0.008));
  const maxSize = Math.max(30, Math.floor(minDim * 0.080));
  
  const qX = new Int32Array(6000);
  const qY = new Int32Array(6000);
  
  for (let sy = 0; sy < H; sy += 3) {
    for (let sx = 0; sx < W; sx += 3) {
      const vIdx = sy * W + sx;
      if (visited[vIdx]) continue;
      
      const idx = (sy * W + sx) * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
      
      if (lum >= darkThreshold) {
        visited[vIdx] = 1;
        continue;
      }
      
      let head = 0, tail = 0;
      qX[tail] = sx; qY[tail] = sy; tail++;
      visited[vIdx] = 1;
      
      let bMinX = sx, bMaxX = sx, bMinY = sy, bMaxY = sy;
      let sumX = 0, sumY = 0, count = 0;
      
      while (head < tail) {
        const cx = qX[head], cy = qY[head];
        head++; count++; sumX += cx; sumY += cy;
        
        if (cx < bMinX) bMinX = cx;
        if (cx > bMaxX) bMaxX = cx;
        if (cy < bMinY) bMinY = cy;
        if (cy > bMaxY) bMaxY = cy;
        
        const neighbors = [[cx+2, cy], [cx-2, cy], [cx, cy+2], [cx, cy-2]];
        for (let i = 0; i < 4; i++) {
          const nx = neighbors[i][0], ny = neighbors[i][1];
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const nVidx = ny * W + nx;
            if (!visited[nVidx]) {
              visited[nVidx] = 1;
              const nIdx = (ny * W + nx) * 4;
              const nLum = 0.299 * data[nIdx] + 0.587 * data[nIdx+1] + 0.114 * data[nIdx+2];
              if (nLum < darkThreshold && tail < 5990) {
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
        if (aspect >= 0.55 && aspect <= 1.8) {
          const expected = (bw / 2) * (bh / 2);
          const solidity = expected > 0 ? count / expected : 0;
          if (solidity >= 0.35) {
            const cx = sumX / count;
            const cy = sumY / count;
            
            const pad = 4;
            let sx0 = Math.max(0, bMinX - pad), sx1 = Math.min(W - 1, bMaxX + pad);
            let sy0 = Math.max(0, bMinY - pad), sy1 = Math.min(H - 1, bMaxY + pad);
            let surrSum = 0, surrCnt = 0;
            for (let py = sy0; py <= sy1; py += 2) {
              for (let px = sx0; px <= sx1; px += 2) {
                 if (px >= bMinX && px <= bMaxX && py >= bMinY && py <= bMaxY) continue;
                 const pIdx = (py * W + px) * 4;
                 surrSum += 0.299 * data[pIdx] + 0.587 * data[pIdx+1] + 0.114 * data[pIdx+2];
                 surrCnt++;
              }
            }
            const surrMean = surrCnt > 0 ? surrSum / surrCnt : 255;
            if (surrMean > darkThreshold + 20) {
              candidates.push({ x: cx, y: cy });
            }
          }
        }
      }
    }
  }
  
  if (candidates.length < 4) return null;
  
  candidates.sort((a, b) => a.y - b.y);
  
  const tops = candidates.slice(0, Math.min(3, Math.ceil(candidates.length / 2)));
  const bots = candidates.slice(-Math.min(3, Math.ceil(candidates.length / 2)));
  
  tops.sort((a, b) => a.x - b.x);
  bots.sort((a, b) => a.x - b.x);
  
  const tl = tops[0];
  const tr = tops[tops.length - 1];
  const bl = bots[0];
  const br = bots[bots.length - 1];
  
  const topWidth = tr.x - tl.x;
  const botWidth = br.x - bl.x;
  const leftHeight = bl.y - tl.y;
  const rightHeight = br.y - tr.y;
  
  if (topWidth < W * 0.35 || botWidth < W * 0.35 || leftHeight < H * 0.35 || rightHeight < H * 0.35) {
    return null;
  }
  
  return { tl, tr, bl, br };
}

function warpPerspectiveToCanvas(srcImgData, corners, dstCtx, dstW, dstH) {
  const src = [
    corners.tl.x, corners.tl.y,
    corners.tr.x, corners.tr.y,
    corners.br.x, corners.br.y,
    corners.bl.x, corners.bl.y
  ];
  const dst = [0, 0, dstW, 0, dstW, dstH, 0, dstH];
  const H_inv = getPerspectiveTransform(dst, src);

  const dstImgData = dstCtx.createImageData(dstW, dstH);
  const dstData = dstImgData.data;
  const srcData = srcImgData.data;
  const srcW = srcImgData.width;
  const srcH = srcImgData.height;

  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const denominator = H_inv[6] * x + H_inv[7] * y + H_inv[8];
      const sx = (H_inv[0] * x + H_inv[1] * y + H_inv[2]) / denominator;
      const sy = (H_inv[3] * x + H_inv[4] * y + H_inv[5]) / denominator;
      const dstIdx = (y * dstW + x) * 4;

      if (sx >= 0 && sx < srcW - 1 && sy >= 0 && sy < srcH - 1) {
        const x0 = Math.floor(sx), x1 = x0 + 1;
        const y0 = Math.floor(sy), y1 = y0 + 1;
        const dx = sx - x0, dy = sy - y0;

        const idx00 = (y0 * srcW + x0) * 4;
        const idx10 = (y0 * srcW + x1) * 4;
        const idx01 = (y1 * srcW + x0) * 4;
        const idx11 = (y1 * srcW + x1) * 4;

        for (let c = 0; c < 3; c++) {
          dstData[dstIdx + c] = (1 - dx) * (1 - dy) * srcData[idx00 + c] +
                                dx * (1 - dy) * srcData[idx10 + c] +
                                (1 - dx) * dy * srcData[idx01 + c] +
                                dx * dy * srcData[idx11 + c];
        }
        dstData[dstIdx + 3] = 255;
      } else {
        dstData[dstIdx] = 255; dstData[dstIdx + 1] = 255; dstData[dstIdx + 2] = 255; dstData[dstIdx + 3] = 255;
      }
    }
  }
  dstCtx.putImageData(dstImgData, 0, 0);
}

function getPerspectiveTransform(src, dst) {
  const a = [];
  for (let i = 0; i < 4; i++) {
    const sx = src[i * 2], sy = src[i * 2 + 1];
    const dx = dst[i * 2], dy = dst[i * 2 + 1];
    a.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy, dx]);
    a.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy, dy]);
  }
  for (let i = 0; i < 8; i++) {
    let maxRow = i;
    for (let k = i + 1; k < 8; k++) {
      if (Math.abs(a[k][i]) > Math.abs(a[maxRow][i])) maxRow = k;
    }
    const temp = a[i]; a[i] = a[maxRow]; a[maxRow] = temp;
    for (let k = i + 1; k < 8; k++) {
      const c = -a[k][i] / a[i][i];
      for (let j = i; j <= 8; j++) {
        if (i === j) a[k][j] = 0;
        else a[k][j] += c * a[i][j];
      }
    }
  }
  const h = new Array(9);
  h[8] = 1;
  for (let i = 7; i >= 0; i--) {
    let sum = a[i][8];
    for (let j = i + 1; j < 8; j++) sum -= a[i][j] * h[j];
    h[i] = sum / a[i][i];
  }
  return h;
}

async function decodeStudentQRMultiStage(videoElement, rawCanvas) {
  if (nativeBarcodeDetector) {
    try {
      const barcodes = await nativeBarcodeDetector.detect(videoElement);
      if (barcodes && barcodes.length > 0) return cleanQrPayload(barcodes[0].rawValue);
    } catch (e) {}
  }

  if (typeof jsQR !== "undefined" && rawCanvas) {
    const probeW = Math.min(rawCanvas.width, 800);
    const probeH = Math.round(probeW * (rawCanvas.height / rawCanvas.width));
    const pCanvas = document.createElement('canvas');
    pCanvas.width = probeW; pCanvas.height = probeH;
    const pCtx = pCanvas.getContext('2d');
    pCtx.drawImage(rawCanvas, 0, 0, probeW, probeH);

    let imgData = pCtx.getImageData(0, 0, probeW, probeH);
    let code = jsQR(imgData.data, probeW, probeH, { inversionAttempts: "attemptBoth" });
    if (code && code.data) return cleanQrPayload(code.data);

    const headerH = Math.round(probeH * 0.40);
    const headerData = pCtx.getImageData(0, 0, probeW, headerH);
    code = jsQR(headerData.data, probeW, headerH, { inversionAttempts: "attemptBoth" });
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

async function processCameraFrame() {
  stopAutoScanLoop();

  const video = document.getElementById('scanner-video');
  const displayCanvas = document.getElementById('scanner-canvas');
  if (!video.videoWidth) return alert("Camera is not ready yet.");

  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = 640;
  const probeH = Math.round(640 * (video.videoHeight / video.videoWidth));
  probeCanvas.height = probeH;
  const pCtx = probeCanvas.getContext('2d');
  pCtx.drawImage(video, 0, 0, 640, probeH);
  const probeImg = pCtx.getImageData(0, 0, 640, probeH);

  const probeCorners = findFourCornersRobust(probeImg, 640, probeH);
  if (!probeCorners) {
    alert("Please completely center the four corner registration squares inside the viewfinder.");
    resetToLiveCamera();
    return;
  }

  const scaleX = video.videoWidth / 640;
  const scaleY = video.videoHeight / probeH;
  const corners = {
    tl: { x: probeCorners.tl.x * scaleX, y: probeCorners.tl.y * scaleY },
    tr: { x: probeCorners.tr.x * scaleX, y: probeCorners.tr.y * scaleY },
    bl: { x: probeCorners.bl.x * scaleX, y: probeCorners.bl.y * scaleY },
    br: { x: probeCorners.br.x * scaleX, y: probeCorners.br.y * scaleY }
  };

  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = video.videoWidth;
  rawCanvas.height = video.videoHeight;
  const rawCtx = rawCanvas.getContext('2d');
  rawCtx.drawImage(video, 0, 0, rawCanvas.width, rawCanvas.height);
  const rawImg = rawCtx.getImageData(0, 0, rawCanvas.width, rawCanvas.height);

  const qrResult = await decodeStudentQRMultiStage(video, rawCanvas);
  let detectedStudentId = "";
  let isForm100 = false;

  if (qrResult) {
    detectedStudentId = qrResult.studentId;
    if (qrResult.formType && qrResult.formType.startsWith('F100')) isForm100 = true;
    matchAndDisplayStudent(detectedStudentId, true);
  }

  let keyItems = builderItems || [];
  const detectedWidth = Math.hypot(probeCorners.tr.x - probeCorners.tl.x, probeCorners.tr.y - probeCorners.tl.y);
  const detectedHeight = Math.hypot(probeCorners.bl.x - probeCorners.tl.x, probeCorners.bl.y - probeCorners.tl.y);
  const detectedRatio = detectedHeight / (detectedWidth || 1);
  
  if (!isForm100 && (detectedRatio > 1.30 || keyItems.length > 50)) {
    isForm100 = true;
  }

  const CANON_W = 400;
  const CANON_H = isForm100 ? 570 : 450;
  displayCanvas.width = CANON_W;
  displayCanvas.height = CANON_H;
  const warpCtx = displayCanvas.getContext('2d');

  warpPerspectiveToCanvas(rawImg, corners, warpCtx, CANON_W, CANON_H);
  cachedWarpedData = warpCtx.getImageData(0, 0, CANON_W, CANON_H);

  if (keyItems.length === 0) {
    const res = await callApi({ action: 'GET_FULL_EXAM_CONFIG', sessionToken, classId: activeClassId });
    if (res.success && res.items) keyItems = res.items;
  }

  if (keyItems.length === 0) {
    alert("No answer key configured for this subject.");
    resetToLiveCamera();
    return;
  }

  const activeSet = document.querySelector('input[name="scan_set"]:checked')?.value || 'A';
  
  video.style.display = 'none';
  displayCanvas.style.display = 'block';
  document.getElementById('viewfinder-overlay').style.display = 'none';
  document.getElementById('btn-retake').style.display = 'inline-block';
  
  // Hand off grading to Python Serverless endpoint
  evaluateWarpedExam100(activeSet, keyItems);
}

function onSetSelectorChange(newSet) {
  if (cachedWarpedData) {
    evaluateWarpedExam100(newSet, builderItems);
  }
}

// Unified call to Python endpoint (handles both 50 and 100 item formats seamlessly)
async function evaluateWarpedExam100(testSet, keyItems) {
  if (!cachedWarpedData) return;
  const displayCanvas = document.getElementById('scanner-canvas');
  const warpCtx = displayCanvas.getContext('2d');
  warpCtx.putImageData(cachedWarpedData, 0, 0);

  // Convert aligned canvas to Base64 to send to Python OpenCV
  const base64Image = displayCanvas.toDataURL('image/jpeg', 0.9);
  const activeStudentId = document.getElementById('scan-detected-id').value.trim();

  document.getElementById('scan-grade-display').innerHTML = `<span class="spinner-border spinner-border-sm text-primary"></span> Processing...`;

  const payload = {
    action: 'AI_VISION_GRADE',
    classId: activeClassId,
    studentId: activeStudentId,
    testSet: testSet,
    items: keyItems,
    base64Image: base64Image
  };

  const res = await callApi(payload);

  if (!res.success) {
    alert("Grading Error: " + res.message);
    resetToLiveCamera();
    return;
  }

  // Update UI with Python results
  document.getElementById('scan-score-display').innerText = `${res.rawScore} / ${res.totalPoints}`;
  document.getElementById('scan-grade-display').innerHTML = `
    <div class="d-flex align-items-center justify-content-center gap-2 mb-1">
      <span class="badge ${res.isPassed ? 'bg-success' : 'bg-danger'} fs-6">${res.status}</span>
      <span class="fw-bold fs-5">${res.percentage}%</span>
    </div>
  `;

  // Render Table Breakdown from Python
  const breakdownContainer = document.getElementById('ai-breakdown-container');
  if (breakdownContainer && res.itemBreakdown) {
    let html = `<table class="table table-sm table-borderless mb-0" style="font-size: 0.73rem;">
      <thead class="table-light sticky-top"><tr><th>Item</th><th>Mark</th><th>Key</th><th>Result</th></tr></thead><tbody>`;
    res.itemBreakdown.forEach(ib => {
      html += `<tr>
        <td>#${ib.itemNo}</td>
        <td>${ib.studentAnswer}</td>
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
    studentId: activeStudentId,
    testSet: testSet,
    answers: res.answers,
    rawScore: res.rawScore,
    totalPoints: res.totalPoints,
    percentage: res.percentage,
    isPassed: res.isPassed
  };

  if (activeStudentId) document.getElementById('btn-save-scan').disabled = false;
}

// Redirect piecewise scans to the unified Python endpoint
function evaluateWarpedExamPiecewise(testSet, keyItems) {
   evaluateWarpedExam100(testSet, keyItems);
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
      items: builderItems // Sent so backend can reliably recount final grade before insert
    });

    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Save Grade to Roster`;

    if (res.success) {
      alert(`Grade recorded!\nRaw: ${res.rawScore}/${res.totalPoints} (${res.percentage}% - ${res.status})`);
      document.getElementById('scan-detected-id').value = "";
      document.getElementById('scan-student-select').value = "";
      matchAndDisplayStudent('', false);
      resetToLiveCamera();
    } else {
      alert("Submission Error: " + res.message);
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Save Grade to Roster`;
    alert("Connection error: " + err);
  }
}