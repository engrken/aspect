import base64
import cv2
import numpy as np

def decode_qr_opencv(gray_img):
    """Attempts to decode the student QR code from the top-right meta box with CLAHE contrast enhancement and 3.0x upscaling."""
    try:
        detector = cv2.QRCodeDetector()
        h, w = gray_img.shape
        qr_crop = gray_img[int(h * 0.04):int(h * 0.32), int(w * 0.60):w]
        
        # Apply Adaptive Histogram Equalization to fix lighting issues
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

def auto_warp_sheet_opencv(gray_img, is_form_100=False):
    H, W = gray_img.shape
    canon_w = 400
    canon_h = 570 if is_form_100 else 450

    if W == canon_w and H in (450, 462, 570, 580):
        if H != canon_h:
            gray_img = cv2.resize(gray_img, (canon_w, canon_h))
        return gray_img, None

    min_lum = float(np.percentile(gray_img, 2))
    max_lum = float(np.percentile(gray_img, 98))
    best_quad = None

    for factor in (0.28, 0.35, 0.42):
        thresh_val = int(min_lum + (max_lum - min_lum) * factor)
        _, binary = cv2.threshold(gray_img, thresh_val, 255, cv2.THRESH_BINARY_INV)
        num_labels, _, stats, centroids = cv2.connectedComponentsWithStats(binary)

        candidates = []
        min_s = max(7, int(min(W, H) * 0.012))
        max_s = max(40, int(min(W, H) * 0.08))

        for i in range(1, num_labels):
            x, y, bw, bh, area = stats[i]
            if min_s <= bw <= max_s and min_s <= bh <= max_s:
                aspect = bw / float(bh)
                if 0.68 <= aspect <= 1.45:
                    solidity = area / float(bw * bh)
                    if solidity >= 0.65:
                        cx, cy = centroids[i]
                        candidates.append({'x': float(cx), 'y': float(cy)})

        tl_list = [c for c in candidates if c['x'] < W * 0.35 and c['y'] < H * 0.35]
        tr_list = [c for c in candidates if c['x'] > W * 0.65 and c['y'] < H * 0.35]
        bl_list = [c for c in candidates if c['x'] < W * 0.35 and c['y'] > H * 0.65]
        br_list = [c for c in candidates if c['x'] > W * 0.65 and c['y'] > H * 0.65]

        if tl_list and tr_list and bl_list and br_list:
            tl = min(tl_list, key=lambda c: c['x'] + c['y'])
            tr = max(tr_list, key=lambda c: c['x'] - c['y'])
            bl = min(bl_list, key=lambda c: c['x'] - c['y'])
            br = max(br_list, key=lambda c: c['x'] + c['y'])

            top_w = float(np.hypot(tr['x'] - tl['x'], tr['y'] - tl['y']))
            bot_w = float(np.hypot(br['x'] - bl['x'], br['y'] - bl['y']))
            left_h = float(np.hypot(bl['x'] - tl['x'], bl['y'] - tl['y']))
            right_h = float(np.hypot(br['x'] - tr['x'], br['y'] - tr['y']))

            if top_w > W * 0.50 and bot_w > W * 0.50 and left_h > H * 0.45 and right_h > H * 0.45:
                if abs(top_w - bot_w) / max(top_w, bot_w) <= 0.20 and abs(left_h - right_h) / max(left_h, right_h) <= 0.20:
                    best_quad = (tl, tr, br, bl)
                    break

    if best_quad is not None:
        tl, tr, br, bl = best_quad
        src_pts = np.array([
            [tl['x'], tl['y']],
            [tr['x'], tr['y']],
            [br['x'], br['y']],
            [bl['x'], bl['y']]
        ], dtype=np.float32)
        dst_pts = np.array([
            [0, 0],
            [canon_w, 0],
            [canon_w, canon_h],
            [0, canon_h]
        ], dtype=np.float32)
        M = cv2.getPerspectiveTransform(src_pts, dst_pts)
        warped = cv2.warpPerspective(gray_img, M, (canon_w, canon_h), borderValue=255)
        _, buf = cv2.imencode('.jpg', warped, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        warped_b64 = base64.b64encode(buf).decode('utf-8')
        return warped, warped_b64

    resized = cv2.resize(gray_img, (canon_w, canon_h))
    _, buf = cv2.imencode('.jpg', resized, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    return resized, base64.b64encode(buf).decode('utf-8')

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

        if drop_from_lightest >= 22.0 and darkest['lum'] < 135.0:
            if separation < 10.0 and (lightest['lum'] - second_darkest['lum']) >= 22.0:
                student_ans = f"{darkest['opt']},{second_darkest['opt']}"
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
                    'r': 6.0 if not is_form_100 else 5.2,
                    'state': state
                })

        item_breakdown.append({
            'itemNo': item_no,
            'studentAnswer': normalized_ans or '(Blank)',
            'correctAnswer': correct_ans,
            'isCorrect': is_correct,
            'bubbles': bubbles_overlay
        })

    return detected_answers, raw_score, total_points, item_breakdown, detected_qr_id, warped_b64