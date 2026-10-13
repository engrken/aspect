import base64
import cv2
import numpy as np

def decode_qr_opencv(gray_img):
    """Attempts to decode the student QR code from the top-right meta box."""
    try:
        detector = cv2.QRCodeDetector()
        h, w = gray_img.shape
        qr_crop = gray_img[int(h * 0.05):int(h * 0.36), int(w * 0.55):w]
        for candidate in [qr_crop, gray_img]:
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
    """
    If the image is already warped to canonical size (400x450 or 400x570), returns it directly.
    Otherwise locates the 4 corner fiducial squares and perspective-warps the sheet.
    """
    H, W = gray_img.shape
    canon_w = 400
    canon_h = 570 if is_form_100 else 450

    if W == canon_w and H == canon_h:
        return gray_img, None

    min_lum = float(np.percentile(gray_img, 2))
    max_lum = float(np.percentile(gray_img, 98))
    best_quad = None
    best_score = -1.0

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
                if 0.65 <= aspect <= 1.50:
                    solidity = area / float(bw * bh)
                    if solidity >= 0.65:
                        cx, cy = centroids[i]
                        candidates.append({
                            'x': float(cx),
                            'y': float(cy),
                            'size': (bw + bh) * 0.5
                        })

        if len(candidates) < 4:
            continue

        horiz_pairs = []
        for i in range(len(candidates)):
            for j in range(len(candidates)):
                if i == j:
                    continue
                left, right = candidates[i], candidates[j]
                dx = right['x'] - left['x']
                dy = abs(right['y'] - left['y'])
                if dx < W * 0.28 or dy > dx * 0.22:
                    continue
                if max(left['size'], right['size']) > min(left['size'], right['size']) * 1.65:
                    continue
                horiz_pairs.append((left, right, float(np.hypot(dx, dy))))

        for i in range(len(horiz_pairs)):
            tl, tr, top_w = horiz_pairs[i]
            for j in range(len(horiz_pairs)):
                if i == j:
                    continue
                bl, br, bot_w = horiz_pairs[j]
                lh = bl['y'] - tl['y']
                rh = br['y'] - tr['y']
                if lh < W * 0.25 or rh < W * 0.25:
                    continue
                if abs(bl['x'] - tl['x']) > lh * 0.22 or abs(br['x'] - tr['x']) > rh * 0.22:
                    continue
                w_diff = abs(top_w - bot_w) / max(top_w, bot_w)
                h_diff = abs(lh - rh) / max(lh, rh)
                if w_diff > 0.22 or h_diff > 0.22:
                    continue
                avg_w = (top_w + bot_w) * 0.5
                avg_h = (lh + rh) * 0.5
                ratio = avg_h / avg_w
                if not (0.75 <= ratio <= 1.65):
                    continue

                score = (avg_w * avg_h) * (1.0 - w_diff) * (1.0 - h_diff)
                if score > best_score:
                    best_score = score
                    best_quad = (tl, tr, br, bl)

        if best_quad is not None:
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
    target_key = 'setB' if str(test_set).upper() == 'B' else 'setA'

    item_coords = {}
    if is_form_100:
        # Exact coordinates for .omr-box-100 (680x640 -> 400x570)
        col_xs = [
            [35.47, 47.09, 58.72, 70.34],
            [132.11, 143.73, 155.35, 166.97],
            [228.75, 240.37, 251.99, 263.61],
            [325.38, 337.00, 348.62, 360.24]
        ]
        row_start_y = 128.11
        row_pitch = 16.710
        for c in range(4):
            for r in range(25):
                item_coords[c * 25 + r + 1] = (col_xs[c], int(round(row_start_y + r * row_pitch)))
        box_r = 4
    else:
        # Exact coordinates for .omr-box-50 (464x492 -> 400x450)
        col_xs = [
            [47.49, 64.84, 82.19, 99.54],
            [177.17, 194.52, 211.87, 229.22],
            [306.85, 324.20, 341.55, 358.90]
        ]
        top_row1_y = 133.26
        bot_row9_y = 287.77
        row_pitch = 17.382

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
        box_r = 4

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
            mean_lum = float(np.mean(roi)) if roi.size > 0 else 255.0
            bubble_stats.append({
                'opt': options[i],
                'lum': mean_lum,
                'x': round(float(cx_f), 1),
                'y': round(float(cy), 1)
            })

        sorted_b = sorted(bubble_stats, key=lambda b: b['lum'])
        darkest = sorted_b[0]
        second_darkest = sorted_b[1]
        lightest = sorted_b[-1]

        drop_from_lightest = lightest['lum'] - darkest['lum']
        separation = second_darkest['lum'] - darkest['lum']

        student_ans = None
        is_double_shaded = False

        if drop_from_lightest >= 20.0 and darkest['lum'] < 130.0:
            if separation < 10.0 and (lightest['lum'] - second_darkest['lum']) >= 20.0:
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
                    'x': b['x'],
                    'y': b['y'],
                    'r': 6.0 if not is_form_100 else 4.5,
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