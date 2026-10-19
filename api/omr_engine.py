import base64
import cv2
import numpy as np

def decode_qr_opencv(gray_img):
    try:
        detector = cv2.QRCodeDetector()
        h, w = gray_img.shape
        qr_crop = gray_img[int(h * 0.04):int(h * 0.32), int(w * 0.60):w]
        
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8,8))
        enhanced = clahe.apply(qr_crop)
        
        upscaled = cv2.resize(enhanced, None, fx=3.0, fy=3.0, interpolation=cv2.INTER_CUBIC)
        _, thresh_qr = cv2.threshold(upscaled, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        for candidate in [upscaled, thresh_qr, enhanced, qr_crop, gray_img]:
            data, _, _ = detector.detectAndDecode(candidate)
            if data:
                cleaned = data.strip()
                if cleaned.startswith("ASPECT|"):
                    parts = cleaned.split("|")
                    return (parts[2] if len(parts) > 2 else parts[1]).strip()
                return cleaned
    except Exception:
        pass
    return None

def _encode_preview(gray_img, original=None, source_corners=None, target_corners=None):
    """Produce a sharp proof image using ORIGINAL camera pixels, not the 400px
    image used for grade calculations. This preserves detail after the warp.
    The scoring geometry must remain 400x450/570 for existing answer keys.
    """
    h, w = gray_img.shape
    factor = 3
    if original is not None and source_corners is not None and target_corners is not None:
        dest = np.asarray(target_corners, dtype=np.float32) * factor
        matrix = cv2.getPerspectiveTransform(np.asarray(source_corners, dtype=np.float32), dest)
        proof = cv2.warpPerspective(
            original, matrix, (w * factor, h * factor),
            flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=255
        )
    else:
        # A source image already at 400px cannot reveal more information.
        # Upsampling here only ensures consistent overlay display sizing.
        proof = cv2.resize(gray_img, (w * factor, h * factor), interpolation=cv2.INTER_CUBIC)
    ok, buf = cv2.imencode('.jpg', proof, [int(cv2.IMWRITE_JPEG_QUALITY), 93])
    if not ok:
        raise ValueError('Could not encode aligned answer-sheet preview.')
    return base64.b64encode(buf).decode('utf-8')


def _ensure_readable(warped):
    """Fail closed on a significantly defocused photo rather than grading
    indistinguishable bubbles. Measured on the 400px canonical OMR grid.
    """
    content = warped[110:min(warped.shape[0] - 25, 425), 25:375]
    if content.size == 0:
        raise ValueError('Photo is too small to grade.')
    sharpness = float(cv2.Laplacian(content, cv2.CV_64F).var())
    if sharpness < 75.0:
        raise ValueError(
            'Captured photo is blurry. Hold the phone still, allow autofocus to '
            'settle, use brighter even lighting, or choose Phone Camera to take '
            'a sharp full-resolution photo. No grade was saved.'
        )


def _fiducials_match(warped, canon_h):
    """Verify the SIX black printed registration marks, not just a quadrilateral."""
    for x in (12, 388):
        for y in (12, 334 if canon_h == 570 else 266, canon_h - 12):
            # Interior square, deliberately clear of anti-aliased outside edges.
            patch = warped[y - 3:y + 4, x - 3:x + 4]
            if patch.size == 0 or float(np.mean(patch)) > 110:
                return False
    return True


def auto_warp_sheet_opencv(gray_img, is_form_100=False):
    """Rectify the printed sheet to its ORIGINAL 400x450 or 400x570 SVG grid.

    The printed corner-mark CENTERS are (12,12), (388,12), (388,H-12),
    (12,H-12). Mapping them to (0,0)...(400,H) moves every answer bubble.
    Never silently resize a photo when the markers were not detected.
    """
    H, W = gray_img.shape
    canon_w = 400
    canon_h = 570 if is_form_100 else 450

    if W == canon_w and H == canon_h and _fiducials_match(gray_img, canon_h):
        _ensure_readable(gray_img)
        return gray_img, _encode_preview(gray_img)

    min_lum = float(np.percentile(gray_img, 2))
    max_lum = float(np.percentile(gray_img, 98))
    if max_lum - min_lum < 30:
        raise ValueError("Image lacks contrast. Use even lighting and a sharp photo.")

    dst_pts = np.array([
        [12, 12],
        [388, 12],
        [388, canon_h - 12],
        [12, canon_h - 12],
    ], dtype=np.float32)

    for factor in (0.25, 0.32, 0.40, 0.48):
        thresh_val = int(min_lum + (max_lum - min_lum) * factor)
        _, binary = cv2.threshold(gray_img, thresh_val, 255, cv2.THRESH_BINARY_INV)
        num_labels, _, stats, centroids = cv2.connectedComponentsWithStats(binary)

        candidates = []
        min_s = max(5, int(min(W, H) * 0.006))
        max_s = max(35, int(min(W, H) * 0.08))
        for i in range(1, num_labels):
            x, y, bw, bh, area = stats[i]
            if not (min_s <= bw <= max_s and min_s <= bh <= max_s):
                continue
            if not (0.67 <= bw / float(bh) <= 1.48):
                continue
            if area / float(bw * bh) < 0.68:
                continue
            cx, cy = centroids[i]
            candidates.append({'x': float(cx), 'y': float(cy)})

        tl_list = [c for c in candidates if c['x'] < W * 0.45 and c['y'] < H * 0.45]
        tr_list = [c for c in candidates if c['x'] > W * 0.55 and c['y'] < H * 0.45]
        bl_list = [c for c in candidates if c['x'] < W * 0.45 and c['y'] > H * 0.55]
        br_list = [c for c in candidates if c['x'] > W * 0.55 and c['y'] > H * 0.55]
        if not all([tl_list, tr_list, bl_list, br_list]):
            continue

        # Sort extremes, then test combinations. A nearby printed character
        # must not override a registration marker just because it is darker.
        tl_candidates = sorted(tl_list, key=lambda c: c['x'] + c['y'])[:4]
        tr_candidates = sorted(tr_list, key=lambda c: c['y'] - c['x'])[:4]
        bl_candidates = sorted(bl_list, key=lambda c: c['x'] - c['y'])[:4]
        br_candidates = sorted(br_list, key=lambda c: -c['x'] - c['y'])[:4]

        for tl in tl_candidates:
            for tr in tr_candidates:
                for bl in bl_candidates:
                    for br in br_candidates:
                        top_w = float(np.hypot(tr['x'] - tl['x'], tr['y'] - tl['y']))
                        bot_w = float(np.hypot(br['x'] - bl['x'], br['y'] - bl['y']))
                        left_h = float(np.hypot(bl['x'] - tl['x'], bl['y'] - tl['y']))
                        right_h = float(np.hypot(br['x'] - tr['x'], br['y'] - tr['y']))
                        if min(top_w, bot_w) < W * 0.12 or min(left_h, right_h) < H * 0.24:
                            continue
                        if abs(top_w - bot_w) / max(top_w, bot_w) > 0.34:
                            continue
                        if abs(left_h - right_h) / max(left_h, right_h) > 0.34:
                            continue

                        shape_ratio = (top_w + bot_w) / max(1.0, left_h + right_h)
                        expected_ratio = canon_w / canon_h
                        if not (expected_ratio * 0.5 <= shape_ratio <= expected_ratio * 1.65):
                            continue

                        src_pts = np.array([
                            [tl['x'], tl['y']], [tr['x'], tr['y']],
                            [br['x'], br['y']], [bl['x'], bl['y']]
                        ], dtype=np.float32)
                        matrix = cv2.getPerspectiveTransform(src_pts, dst_pts)
                        warped = cv2.warpPerspective(
                            gray_img, matrix, (canon_w, canon_h), borderValue=255
                        )
                        if _fiducials_match(warped, canon_h):
                            _ensure_readable(warped)
                            return warped, _encode_preview(
                                warped, original=gray_img,
                                source_corners=src_pts, target_corners=dst_pts
                            )

    raise ValueError(
        "Could not align answer sheet. Ensure all six black registration "
        "squares are visible, the entire sheet is in frame, and lighting is even."
    )

def detect_shaded_test_set(blurred_img, default_set='A'):
    try:
        roi_a = blurred_img[98:109, 87:98]
        roi_b = blurred_img[98:109, 143:154]
        lum_a = float(np.percentile(roi_a, 35)) if roi_a.size > 0 else 255.0
        lum_b = float(np.percentile(roi_b, 35)) if roi_b.size > 0 else 255.0
        if lum_b + 20.0 < lum_a and lum_b < 135.0:
            return 'B'
        if lum_a + 20.0 < lum_b and lum_a < 135.0:
            return 'A'
    except Exception:
        pass
    return str(default_set or 'A').upper()

def grade_sheet_opencv(image_bytes, items, test_set):
    np_arr = np.frombuffer(image_bytes, np.uint8)
    raw_img = cv2.imdecode(np_arr, cv2.IMREAD_GRAYSCALE)
    if raw_img is None:
        raise ValueError("Could not decode image bytes.")

    detected_qr_id = decode_qr_opencv(raw_img)
    total_items = len(items)
    is_form_100 = total_items > 50

    img, warped_b64 = auto_warp_sheet_opencv(raw_img, is_form_100=is_form_100)
    if not detected_qr_id:
        detected_qr_id = decode_qr_opencv(img)

    H, W = img.shape
    blurred = cv2.GaussianBlur(img, (3, 3), 0)

    active_set = detect_shaded_test_set(blurred, default_set=test_set)
    target_key = 'setB' if active_set == 'B' else 'setA'

    item_coords = {}
    if is_form_100:
        col_xs = [
            [46.0, 58.0, 70.0, 82.0],
            [138.0, 150.0, 162.0, 174.0],
            [230.0, 242.0, 254.0, 266.0],
            [322.0, 334.0, 346.0, 358.0]
        ]
        row_start_y = 136.0
        row_pitch = 16.5
        for c in range(4):
            for r in range(25):
                item_coords[c * 25 + r + 1] = (col_xs[c], int(round(row_start_y + r * row_pitch)))
        box_r = 5
    else:
        col_xs = [
            [56.0, 72.0, 88.0, 104.0],
            [180.0, 196.0, 212.0, 228.0],
            [304.0, 320.0, 336.0, 352.0]
        ]
        top_row1_y = 136.0
        bot_row9_y = 284.0
        row_pitch = 16.0

        cols_def = [
            (0, 1, 8, 9, 17),
            (1, 18, 25, 26, 34),
            (2, 35, 42, 43, 50)
        ]
        for col_idx, ts, te, bs, be in cols_def:
            for i in range(ts, te + 1):
                r = i - ts
                item_coords[i] = (col_xs[col_idx], int(round(top_row1_y + r * row_pitch)))
            for i in range(bs, be + 1):
                b = i - bs
                item_coords[i] = (col_xs[col_idx], int(round(bot_row9_y + b * row_pitch)))
        box_r = 5

    detected_answers = {}
    item_breakdown = []
    raw_score = 0
    total_points = 0
    options = ['A', 'B', 'C', 'D']

    for item in items:
        item_no = int(item.get('itemNo', 1))
        pts = int(item.get('points', 1))
        correct_ans = str(item.get(target_key, '')).upper().strip()
        q_type = str(item.get('type', 'MCQ')).upper().strip()

        if item_no not in item_coords:
            continue

        xs, cy = item_coords[item_no]
        cy = min(max(box_r, cy), H - box_r - 1)

        bubble_stats = []
        for i, cx_f in enumerate(xs):
            cx = int(round(cx_f))
            y0, y1 = max(0, cy - box_r), min(H, cy + box_r + 1)
            x0, x1 = max(0, cx - box_r), min(W, cx + box_r + 1)
            roi = blurred[y0:y1, x0:x1]

            if roi.size > 0:
                flat = np.sort(roi.flatten())
                k = max(1, int(len(flat) * 0.40))
                dark_core_lum = float(np.mean(flat[:k]))

                weights = np.clip(200.0 - roi.astype(np.float32), 0.0, None)
                w_sum = float(np.sum(weights))
                if w_sum > 100.0:
                    yy, xx = np.mgrid[y0:y1, x0:x1]
                    snap_x = float(np.sum(xx * weights) / w_sum)
                    snap_y = float(np.sum(yy * weights) / w_sum)
                else:
                    snap_x, snap_y = float(cx_f), float(cy)
            else:
                dark_core_lum = 255.0
                snap_x, snap_y = float(cx_f), float(cy)

            bubble_stats.append({
                'opt': options[i],
                'lum': dark_core_lum,
                'x': round(snap_x, 1),
                'y': round(snap_y, 1),
                'grid_x': round(float(cx_f), 1),
                'grid_y': round(float(cy), 1)
            })

        sorted_b = sorted(bubble_stats, key=lambda b: b['lum'])
        darkest = sorted_b[0]
        second_darkest = sorted_b[1]
        lightest = sorted_b[-1]

        drop_from_lightest = lightest['lum'] - darkest['lum']
        separation = second_darkest['lum'] - darkest['lum']

        student_ans = None
        is_double_shaded = False

        if drop_from_lightest >= 18.0 and darkest['lum'] < 145.0:
            if separation < 9.0 and (lightest['lum'] - second_darkest['lum']) >= 18.0:
                student_ans = ",".join(sorted((darkest['opt'], second_darkest['opt'])))
                is_double_shaded = True
            else:
                student_ans = darkest['opt']

        normalized_ans = student_ans
        if q_type == 'TF' and normalized_ans and not is_double_shaded:
            if normalized_ans == 'A':
                normalized_ans = 'T'
            elif normalized_ans == 'B':
                normalized_ans = 'F'

        is_correct = bool(
            normalized_ans
            and not is_double_shaded
            and (normalized_ans == correct_ans or correct_ans in ['*', 'ALL'])
        )
        if is_correct:
            raw_score += pts

        total_points += pts
        if normalized_ans:
            detected_answers[str(item_no)] = normalized_ans

        bubbles_overlay = []
        for b in bubble_stats:
            opt_norm = b['opt']
            if q_type == 'TF':
                if opt_norm == 'A': opt_norm = 'T'
                elif opt_norm == 'B': opt_norm = 'F'

            was_marked = (b['opt'] in (student_ans or '').split(','))
            is_key = (opt_norm == correct_ans)

            state = 'none'
            if was_marked and is_correct:
                state = 'correct'
            elif was_marked and not is_correct:
                state = 'wrong'
            elif not was_marked and is_key and not is_correct:
                state = 'missed'

            if state != 'none':
                bubbles_overlay.append({
                    'x': b['x'] if was_marked else b['grid_x'],
                    'y': b['y'] if was_marked else b['grid_y'],
                    'r': 5.8 if not is_form_100 else 4.8,
                    'state': state
                })

        item_breakdown.append({
            'itemNo': item_no,
            'studentAnswer': normalized_ans or '(Blank)',
            'correctAnswer': correct_ans,
            'isCorrect': is_correct,
            'bubbles': bubbles_overlay
        })

    return detected_answers, raw_score, total_points, item_breakdown, detected_qr_id, warped_b64, active_set