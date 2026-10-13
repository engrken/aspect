import cv2
import numpy as np

def decode_qr_opencv(gray_img):
    """Attempts to decode the student QR code from the top-right meta box."""
    try:
        detector = cv2.QRCodeDetector()
        # Check cropped QR region first (x=250..398, y=30..160)
        h, w = gray_img.shape
        qr_crop = gray_img[int(h * 0.05):int(h * 0.38), int(w * 0.60):w]
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

def grade_sheet_opencv(image_bytes, items, test_set):
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("Could not decode image bytes.")

    H, W = img.shape
    blurred = cv2.GaussianBlur(img, (3, 3), 0)

    detected_qr_id = decode_qr_opencv(img)

    target_key = 'setB' if str(test_set).upper() == 'B' else 'setA'
    total_items = len(items)
    is_form_100 = (H >= 540) or (total_items > 50)

    item_coords = {}
    if is_form_100:
        col_xs = [
            [29.5, 37.5, 45.5, 53.5],
            [125.5, 133.5, 141.5, 149.5],
            [221.5, 229.5, 237.5, 245.5],
            [317.5, 325.5, 333.5, 341.5]
        ]
        row_start_y = 101.5
        row_pitch = 9.42
        for c in range(4):
            for r in range(25):
                item_coords[c * 25 + r + 1] = (col_xs[c], int(round(row_start_y + r * row_pitch)))
        box_r = 4
    else:
        # Exact X centers for print_sheets.html 3-column layout (.item-row space-between)
        col_xs = [
            [76.9, 91.0, 105.0, 119.1],
            [209.8, 223.9, 237.9, 252.0],
            [342.7, 356.7, 370.8, 384.8]
        ]

        # Dynamic CSS height scaling matching print_sheets.html .half-sheet layout
        max_bot_rows = 0 if total_items <= 8 else min(9, total_items - 8)
        if max_bot_rows > 0:
            total_h_css = 307.0 + (max_bot_rows - 1) * 17.5
        else:
            total_h_css = 289.5

        scale_y = 450.0 / total_h_css

        cols_def = [
            (0, 1, 8, 9, 17),
            (1, 18, 25, 26, 34),
            (2, 35, 42, 43, 50)
        ]
        for col_idx, ts, te, bs, be in cols_def:
            for i in range(ts, te + 1):
                r = i - ts
                y_css = 149.0 + r * 17.5
                item_coords[i] = (col_xs[col_idx], int(round(y_css * scale_y)))
            for i in range(bs, be + 1):
                b = i - bs
                y_css = 307.0 + b * 17.5
                item_coords[i] = (col_xs[col_idx], int(round(y_css * scale_y)))
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

        # Sort by darkest (lowest luminance) first
        sorted_b = sorted(bubble_stats, key=lambda b: b['lum'])
        darkest = sorted_b[0]
        second_darkest = sorted_b[1]
        lightest = sorted_b[-1]

        # Relative darkness drop compared to unshaded bubbles in the same row
        drop_from_lightest = lightest['lum'] - darkest['lum']
        separation = second_darkest['lum'] - darkest['lum']

        student_ans = None
        is_double_shaded = False

        # A shaded bubble is significantly darker than unshaded bubbles in the same row
        if drop_from_lightest >= 22.0 and darkest['lum'] < 105.0:
            if separation < 10.0 and (lightest['lum'] - second_darkest['lum']) >= 22.0:
                # Two bubbles shaded on the same row (e.g., Item 6 in test sheet)
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

        # Build visual ring overlays for scanner canvas
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
                    'r': 5.8 if not is_form_100 else 4.2,
                    'state': state
                })

        item_breakdown.append({
            'itemNo': item_no,
            'studentAnswer': normalized_ans or '(Blank)',
            'correctAnswer': correct_ans,
            'isCorrect': is_correct,
            'bubbles': bubbles_overlay
        })

    return detected_answers, raw_score, total_points, item_breakdown, detected_qr_id