import cv2
import numpy as np

def grade_sheet_opencv(image_bytes, items, test_set):
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError("Could not decode image bytes.")

    H, W = img.shape
    blurred = cv2.GaussianBlur(img, (3, 3), 0)
    thresh = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 5
    )

    target_key = 'setB' if str(test_set).upper() == 'B' else 'setA'
    is_form_100 = (H > 500) or (len(items) > 50)

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
        col_xs = [
            [52.0, 66.5, 81.0, 95.5],
            [178.0, 192.5, 207.0, 221.5],
            [304.5, 319.0, 333.5, 348.0]
        ]
        top_row1_y = 98.0
        top_pitch = (228.0 - 7.5 - top_row1_y) / 7.0
        bot_row9_y = 247.0 + 19.0
        bot_pitch = (406.0 - bot_row9_y) / 8.0

        cols_def = [
            (0, 1, 8, 9, 17),
            (1, 18, 25, 26, 34),
            (2, 35, 42, 43, 50)
        ]
        for col_idx, ts, te, bs, be in cols_def:
            for i in range(ts, te + 1):
                item_coords[i] = (col_xs[col_idx], int(round(top_row1_y + (i - ts) * top_pitch)))
            for i in range(bs, be + 1):
                item_coords[i] = (col_xs[col_idx], int(round(bot_row9_y + (i - bs) * bot_pitch)))
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
        bubble_results = []

        for i, cx_f in enumerate(xs):
            cx = int(round(cx_f))
            y0, y1 = max(0, cy - box_r), min(H, cy + box_r + 1)
            x0, x1 = max(0, cx - box_r), min(W, cx + box_r + 1)
            roi = thresh[y0:y1, x0:x1]
            fill_ratio = (cv2.countNonZero(roi) / float(roi.size)) if roi.size > 0 else 0.0
            bubble_results.append({'opt': options[i], 'fill': fill_ratio})

        bubble_results.sort(key=lambda b: b['fill'], reverse=True)
        top = bubble_results[0]
        runner_up = bubble_results[1]

        student_ans = None
        if top['fill'] >= 0.28 and (top['fill'] - runner_up['fill']) >= 0.12:
            student_ans = top['opt']

        if q_type == 'TF' and student_ans:
            if student_ans == 'A':
                student_ans = 'T'
            elif student_ans == 'B':
                student_ans = 'F'

        is_correct = bool(student_ans and (student_ans == correct_ans or correct_ans in ['*', 'ALL']))
        if is_correct:
            raw_score += pts

        total_points += pts
        if student_ans:
            detected_answers[str(item_no)] = student_ans

        item_breakdown.append({
            'itemNo': item_no,
            'studentAnswer': student_ans or '(Blank)',
            'correctAnswer': correct_ans,
            'isCorrect': is_correct
        })

    return detected_answers, raw_score, total_points, item_breakdown