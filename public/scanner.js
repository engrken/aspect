/**
 * ASPECT Engine — Optical Mark Recognition & Vision Pipeline
 * Outer-Quadrant Fiducial Lock + High-Res QR Decoder
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
    if (metaEl) metaEl.innerText = 'Auto-detected from sheet (unlisted in section)';
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
        width: { min: 720, ideal: 1280, max: 1920 },
        height: { min: 480, ideal: 960, max: 1440 }
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
  updateTargetUI(false);
  startAutoScanLoop();
}

function updateTargetUI(isLocked) {
  const frame = document.getElementById('viewfinder-frame');
  const brackets = document.querySelectorAll('.target-bracket');
  const label = document.getElementById('align-instruction');
  const color = isLocked ? '#198754' : '#0d6efd';

  if (frame) frame.style.borderColor = isLocked ? 'rgba(25, 135, 84, 0.85)' : 'rgba(255,255,255,0.35)';
  brackets.forEach(b => b.style.borderColor = color);

  if (label) {
    if (isLocked) {
      label.innerText = `Corners Locked! Capturing (${stableAlignmentCount}/${REQUIRED_STABLE_FRAMES})...`;
      label.style.color = '#20c997';
    } else {
      label.innerText = "Fit all 4 outer corner black squares inside the frame";
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
          await processCameraFrame(corners, probeH);
        } catch (err) {
          console.error("Auto-scan error:", err);
          resetToLiveCamera();
        } finally {
          isScanningFrame = false;
        }
      }
    } else {
      stableAlignmentCount = 0;
      updateTargetUI(false);
    }
  }, 150);
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
  const minSize = 8;
  const maxSize = 36;

  const qX = new Int32Array(3000);
  const qY = new Int32Array(3000);

  const startY = 6, endY = H - 6;
  const startX = 6, endX = W - 6;

  for (let sy = startY; sy < endY; sy += 2) {
    for (let sx = startX; sx < endX; sx += 2) {
      const vIdx = sy * W + sx;
      if (visited[vIdx]) continue;

      const idx = vIdx * 4;
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
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
            const pad = 5;
            const sx0 = Math.max(0, bMinX - pad), sx1 = Math.min(W - 1, bMaxX + pad);
            const sy0 = Math.max(0, bMinY - pad), sy1 = Math.min(H - 1, bMaxY + pad);
            let surrSum = 0, surrCnt = 0;
            for (let py = sy0; py <= sy1; py += 2) {
              for (let px = sx0; px <= sx1; px += 2) {
                if (px >= bMinX - 1 && px <= bMaxX + 1 && py >= bMinY - 1 && py <= bMaxY + 1) continue;
                const pIdx = (py * W + px) * 4;
                surrSum += 0.299 * data[pIdx] + 0.587 * data[pIdx + 1] + 0.114 * data[pIdx + 2];
                surrCnt++;
              }
            }
            const surrMean = surrCnt > 0 ? surrSum / surrCnt : 0;
            if (surrMean > darkThreshold + 25) {
              candidates.push({
                x: sumX / count,
                y: sumY / count,
                bw,
                bh,
                size: (bw + bh) * 0.5
              });
            }
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

  const tl = tlList[0];
  const tr = trList[0];
  const bl = blList[0];
  const br = brList[0];

  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const botW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

  if (topW < W * 0.45 || botW < W * 0.45 || leftH < W * 0.40 || rightH < W * 0.40) return null;
  if (Math.abs(topW - botW) / Math.max(topW, botW) > 0.18) return null;
  if (Math.abs(leftH - rightH) / Math.max(leftH, rightH) > 0.18) return null;

  return { tl, tr, bl, br };
}

function warpPerspectiveToCanvas(srcImgData, corners, dstCtx, dstW, dstH) {
  const src = [
    corners.tl.x, corners.tl.y,
    corners.tr.x, corners.tr.y,
    corners.br.x, corners.br.y,
    corners.bl.x, corners.bl.y
  ];
  const dst = [
    12, 12,
    dstW - 12, 12,
    dstW - 12, dstH - 12,
    12, dstH - 12
  ];
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
    const rx = Math.floor(rawCanvas.width * 0.45);
    const ry = 0;
    const rw = rawCanvas.width - rx;
    const rh = Math.floor(rawCanvas.height * 0.45);
    const qrCropCanvas = document.createElement('canvas');
    qrCropCanvas.width = rw;
    qrCropCanvas.height = rh;
    const qrCtx = qrCropCanvas.getContext('2d');
    qrCtx.drawImage(rawCanvas, rx, ry, rw, rh, 0, 0, rw, rh);
    const cropData = qrCtx.getImageData(0, 0, rw, rh);
    let code = jsQR(cropData.data, rw, rh, { inversionAttempts: "attemptBoth" });
    if (code && code.data) return cleanQrPayload(code.data);

    const probeW = Math.min(rawCanvas.width, 1000);
    const probeH = Math.round(probeW * (rawCanvas.height / rawCanvas.width));
    const pCanvas = document.createElement('canvas');
    pCanvas.width = probeW; pCanvas.height = probeH;
    const pCtx = pCanvas.getContext('2d');
    pCtx.drawImage(rawCanvas, 0, 0, probeW, probeH);
    const imgData = pCtx.getImageData(0, 0, probeW, probeH);
    code = jsQR(imgData.data, probeW, probeH, { inversionAttempts: "attemptBoth" });
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

async function processCameraFrame(preDetectedCorners = null, preProbeH = null) {
  stopAutoScanLoop();

  const video = document.getElementById('scanner-video');
  const displayCanvas = document.getElementById('scanner-canvas');
  if (!video.videoWidth) return alert("Camera is not ready yet.");

  let keyItems = builderItems || [];
  if (keyItems.length === 0) {
    const res = await callApi({ action: 'GET_FULL_EXAM_CONFIG', sessionToken, classId: activeClassId });
    if (res.success && res.items) {
      keyItems = res.items;
      builderItems = res.items;
    }
  }

  if (keyItems.length === 0) {
    alert("No answer key configured for this subject.");
    resetToLiveCamera();
    return;
  }

  const probeH = preProbeH || Math.round(640 * (video.videoHeight / video.videoWidth));
  let probeCorners = preDetectedCorners;

  if (!probeCorners) {
    const probeCanvas = document.createElement('canvas');
    probeCanvas.width = 640;
    probeCanvas.height = probeH;
    const pCtx = probeCanvas.getContext('2d');
    pCtx.drawImage(video, 0, 0, 640, probeH);
    const probeImg = pCtx.getImageData(0, 0, 640, probeH);
    probeCorners = findFourCornersRobust(probeImg, 640, probeH);
  }

  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = video.videoWidth;
  rawCanvas.height = video.videoHeight;
  const rawCtx = rawCanvas.getContext('2d');
  rawCtx.drawImage(video, 0, 0, rawCanvas.width, rawCanvas.height);
  const rawImg = rawCtx.getImageData(0, 0, rawCanvas.width, rawCanvas.height);

  const qrResult = await decodeStudentQRMultiStage(video, rawCanvas);
  if (qrResult && qrResult.studentId) {
    matchAndDisplayStudent(qrResult.studentId, true);
  }

  const isForm100 = keyItems.length > 50;
  const CANON_W = 400;
  const CANON_H = isForm100 ? 570 : 450;

  displayCanvas.width = CANON_W;
  displayCanvas.height = CANON_H;
  const warpCtx = displayCanvas.getContext('2d');

  if (probeCorners) {
    const scaleX = video.videoWidth / 640;
    const scaleY = video.videoHeight / probeH;
    const corners = {
      tl: { x: probeCorners.tl.x * scaleX, y: probeCorners.tl.y * scaleY },
      tr: { x: probeCorners.tr.x * scaleX, y: probeCorners.tr.y * scaleY },
      bl: { x: probeCorners.bl.x * scaleX, y: probeCorners.bl.y * scaleY },
      br: { x: probeCorners.br.x * scaleX, y: probeCorners.br.y * scaleY }
    };
    warpPerspectiveToCanvas(rawImg, corners, warpCtx, CANON_W, CANON_H);
    cachedWarpedData = warpCtx.getImageData(0, 0, CANON_W, CANON_H);
  } else {
    const sendW = 800;
    const sendH = Math.round(800 * (video.videoHeight / video.videoWidth));
    displayCanvas.width = sendW;
    displayCanvas.height = sendH;
    warpCtx.drawImage(video, 0, 0, sendW, sendH);
    cachedWarpedData = warpCtx.getImageData(0, 0, sendW, sendH);
  }

  const activeSet = document.querySelector('input[name="scan_set"]:checked')?.value || 'A';

  video.style.display = 'none';
  displayCanvas.style.display = 'block';
  document.getElementById('viewfinder-overlay').style.display = 'none';
  document.getElementById('btn-retake').style.display = 'inline-block';

  await evaluateWarpedExam100(activeSet, keyItems);
}

function onSetSelectorChange(newSet) {
  if (cachedWarpedData) {
    evaluateWarpedExam100(newSet, builderItems);
  }
}

async function evaluateWarpedExam100(testSet, keyItems) {
  if (!cachedWarpedData) return;
  const displayCanvas = document.getElementById('scanner-canvas');
  const warpCtx = displayCanvas.getContext('2d');
  warpCtx.putImageData(cachedWarpedData, 0, 0);

  const base64Image = displayCanvas.toDataURL('image/jpeg', 0.92);
  let activeStudentId = document.getElementById('scan-detected-id').value.trim();

  document.getElementById('scan-grade-display').innerHTML = `<span class="spinner-border spinner-border-sm text-primary"></span> Grading with OpenCV...`;

  const payload = {
    action: 'AI_VISION_GRADE',
    sessionToken: sessionToken,
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

  if (!activeStudentId && res.studentId) {
    activeStudentId = res.studentId;
    matchAndDisplayStudent(activeStudentId, true);
  }

  if (res.detectedSet) {
    const radioEl = document.getElementById(res.detectedSet === 'B' ? 'scan_set_b' : 'scan_set_a');
    if (radioEl) radioEl.checked = true;
  }

  if (res.warpedBase64) {
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        displayCanvas.width = img.width;
        displayCanvas.height = img.height;
        warpCtx.drawImage(img, 0, 0);
        cachedWarpedData = warpCtx.getImageData(0, 0, img.width, img.height);
        resolve();
      };
      img.onerror = resolve;
      img.src = "data:image/jpeg;base64," + res.warpedBase64;
    });
  }

  drawValidationOverlays(warpCtx, res.itemBreakdown);

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
        <td class="fw-bold">${ib.studentAnswer}</td>
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
    testSet: res.detectedSet || testSet,
    answers: res.answers,
    rawScore: res.rawScore,
    totalPoints: res.totalPoints,
    percentage: res.percentage,
    isPassed: res.isPassed,
    warpedBase64: res.warpedBase64 || base64Image,
    itemBreakdown: res.itemBreakdown
  };

  if (activeStudentId) {
    document.getElementById('btn-save-scan').disabled = false;
  }
}

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
      items: builderItems,
      warpedBase64: lastScannedData.warpedBase64,
      itemBreakdown: lastScannedData.itemBreakdown
    });

    btn.disabled = false;
    btn.innerHTML = `<i class="bi bi-cloud-arrow-up-fill me-1"></i> Save Grade to Roster`;

    if (res.success) {
      alert(`Grade recorded for ${res.fullName}!\nRaw: ${res.rawScore}/${res.totalPoints} (${res.percentage}% - ${res.status})`);
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

window.drawValidationOverlays = drawValidationOverlays;