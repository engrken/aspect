/**
 * ASPECT Engine — Optical Mark Recognition & Vision Pipeline
 * Client + Server OpenCV Hybrid Registration (1-50 & 51-100 Item Sheets)
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
      label.innerText = "Fit the 4 corner black squares inside the frame (or tap Scan)";
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

/**
 * Separates .f-bl from "15." using tight core thresholding (0.28) + 1px flood-fill
 * and locks onto the parallel Left/Right fiducial rails.
 */
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

  if (maxLum - minLum < 30) return null;
  // Tight 0.28 threshold prevents .f-bl from bridging across the 2px gap into "15."
  const darkThreshold = minLum + (maxLum - minLum) * 0.28;

  const visited = new Uint8Array(W * H);
  const candidates = [];
  const minSize = 8;
  const maxSize = 36;

  const qX = new Int32Array(3000);
  const qY = new Int32Array(3000);

  const startY = 8, endY = H - 8;
  const startX = 8, endX = W - 8;

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

      // 1-pixel step BFS so thin gaps are respected accurately
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
        if (aspect >= 0.65 && aspect <= 1.50) {
          const areaRatio = count / (bw * bh);
          if (areaRatio >= 0.62) {
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

  if (candidates.length < 4) return null;

  // Find pairs of top and bottom horizontal segments that form a valid rectangle
  const horizPairs = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const left = candidates[i], right = candidates[j];
      const dx = right.x - left.x;
      const dy = Math.abs(right.y - left.y);
      if (dx < W * 0.30) continue;
      if (dy > dx * 0.20) continue;
      if (Math.max(left.size, right.size) > Math.min(left.size, right.size) * 1.6) continue;
      horizPairs.push({ left, right, width: Math.hypot(dx, dy) });
    }
  }

  let bestQuad = null;
  let bestScore = -1;

  for (let i = 0; i < horizPairs.length; i++) {
    const topP = horizPairs[i];
    for (let j = 0; j < horizPairs.length; j++) {
      if (i === j) continue;
      const botP = horizPairs[j];

      const lh = botP.left.y - topP.left.y;
      const rh = botP.right.y - topP.right.y;
      // Compare height to W (not H) so portrait 16:9 phones never reject half-sheets
      if (lh < W * 0.22 || rh < W * 0.22) continue;

      if (Math.abs(botP.left.x - topP.left.x) > lh * 0.20) continue;
      if (Math.abs(botP.right.x - topP.right.x) > rh * 0.20) continue;

      const wDiff = Math.abs(topP.width - botP.width) / Math.max(topP.width, botP.width);
      const hDiff = Math.abs(lh - rh) / Math.max(lh, rh);
      if (wDiff > 0.20 || hDiff > 0.20) continue;

      const avgW = (topP.width + botP.width) * 0.5;
      const avgH = (lh + rh) * 0.5;
      const ratio = avgH / avgW;
      if (ratio < 0.50 || ratio > 1.85) continue;

      // Bonus if middle rail fiducials (f-ml, f-mr) lie on the left and right edges
      let midRailBonus = 1.0;
      const midLeftX = (topP.left.x + botP.left.x) * 0.5;
      const midRightX = (topP.right.x + botP.right.x) * 0.5;
      for (const c of candidates) {
        if (c === topP.left || c === botP.left || c === topP.right || c === botP.right) continue;
        if (c.y > topP.left.y + lh * 0.25 && c.y < botP.left.y - lh * 0.20) {
          if (Math.abs(c.x - midLeftX) < 18) midRailBonus += 0.5;
          if (Math.abs(c.x - midRightX) < 18) midRailBonus += 0.5;
        }
      }

      const score = (avgW * avgH) * midRailBonus * (1.0 - wDiff) * (1.0 - hDiff);
      if (score > bestScore) {
        bestScore = score;
        bestQuad = { tl: topP.left, tr: topP.right, bl: botP.left, br: botP.right };
      }
    }
  }

  return bestQuad;
}

function warpPerspectiveToCanvas(srcImgData, corners, dstCtx, dstW, dstH, fiducialBottomY) {
  const src = [
    corners.tl.x, corners.tl.y,
    corners.tr.x, corners.tr.y,
    corners.br.x, corners.br.y,
    corners.bl.x, corners.bl.y
  ];
  const botY = fiducialBottomY || dstH;
  const dst = [0, 0, dstW, 0, dstW, botY, 0, botY];
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

async function decodeStudentQRMultiStage(videoElement, rawCanvas, warpedCanvas) {
  if (nativeBarcodeDetector) {
    try {
      const barcodes = await nativeBarcodeDetector.detect(videoElement);
      if (barcodes && barcodes.length > 0) return cleanQrPayload(barcodes[0].rawValue);
    } catch (e) {}
  }

  if (typeof jsQR !== "undefined") {
    if (warpedCanvas) {
      const wCtx = warpedCanvas.getContext('2d');
      const fullWarped = wCtx.getImageData(0, 0, warpedCanvas.width, warpedCanvas.height);
      const code = jsQR(fullWarped.data, warpedCanvas.width, warpedCanvas.height, { inversionAttempts: "attemptBoth" });
      if (code && code.data) return cleanQrPayload(code.data);
    }
    if (rawCanvas) {
      const probeW = Math.min(rawCanvas.width, 800);
      const probeH = Math.round(probeW * (rawCanvas.height / rawCanvas.width));
      const pCanvas = document.createElement('canvas');
      pCanvas.width = probeW; pCanvas.height = probeH;
      const pCtx = pCanvas.getContext('2d');
      pCtx.drawImage(rawCanvas, 0, 0, probeW, probeH);

      const imgData = pCtx.getImageData(0, 0, probeW, probeH);
      const code = jsQR(imgData.data, probeW, probeH, { inversionAttempts: "attemptBoth" });
      if (code && code.data) return cleanQrPayload(code.data);
    }
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
  itemBreakdown.forEach(ib => {
    if (!ib.bubbles) return;
    ib.bubbles.forEach(b => {
      ctx.save();
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r || 5.5, 0, 2 * Math.PI);
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

  const isForm100 = keyItems.length > 50;
  const CANON_W = 400;
  const FIDUCIAL_H = isForm100 ? 570 : 450;
  const CANON_H = isForm100 ? 580 : 462;

  displayCanvas.width = CANON_W;
  displayCanvas.height = CANON_H;
  const warpCtx = displayCanvas.getContext('2d');

  if (probeCorners) {
    // Client-side warp when corners are locked
    const scaleX = video.videoWidth / 640;
    const scaleY = video.videoHeight / probeH;
    const corners = {
      tl: { x: probeCorners.tl.x * scaleX, y: probeCorners.tl.y * scaleY },
      tr: { x: probeCorners.tr.x * scaleX, y: probeCorners.tr.y * scaleY },
      bl: { x: probeCorners.bl.x * scaleX, y: probeCorners.bl.y * scaleY },
      br: { x: probeCorners.br.x * scaleX, y: probeCorners.br.y * scaleY }
    };
    warpPerspectiveToCanvas(rawImg, corners, warpCtx, CANON_W, CANON_H, FIDUCIAL_H);
    cachedWarpedData = warpCtx.getImageData(0, 0, CANON_W, CANON_H);
  } else {
    // Fallback: Send scaled raw frame so Python OpenCV warps it on the server
    const sendW = 800;
    const sendH = Math.round(800 * (video.videoHeight / video.videoWidth));
    displayCanvas.width = sendW;
    displayCanvas.height = sendH;
    warpCtx.drawImage(video, 0, 0, sendW, sendH);
    cachedWarpedData = warpCtx.getImageData(0, 0, sendW, sendH);
  }

  const qrResult = await decodeStudentQRMultiStage(video, rawCanvas, probeCorners ? displayCanvas : null);
  if (qrResult && qrResult.studentId) {
    matchAndDisplayStudent(qrResult.studentId, true);
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

  const base64Image = displayCanvas.toDataURL('image/jpeg', 0.90);
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

  // If server-side OpenCV warped a raw camera frame, load the server's warped image onto the canvas
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
    testSet: testSet,
    answers: res.answers,
    rawScore: res.rawScore,
    totalPoints: res.totalPoints,
    percentage: res.percentage,
    isPassed: res.isPassed
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
      items: builderItems
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