import cv2
import numpy as np

def grade_sheet_opencv(image_bytes, items, test_set):
    # 1. Decode Image from Base64 bytes
    np_arr = np.frombuffer(image_bytes, np.uint8)
    img = cv2.imdecode(np_arr, cv2.IMREAD_GRAYSCALE)
    
    # 2. Adaptive Binary Thresholding (Dark pencil marks become white pixels)
    blurred = cv2.GaussianBlur(img, (3, 3), 0)
    thresh = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 15, 5)
    
    target_key = 'setB' if test_set == 'B' else 'setA'
    
    # 100-Item Matrix coordinates mapping exact JS alignments
    colXs = [
        [29.5, 37.5, 45.5, 53.5],
        [125.5, 133.5, 141.5, 149.5],
        [221.5, 229.5, 237.5, 245.5],
        [317.5, 325.5, 333.5, 341.5]
    ]
    rowStartY = 101.5
    rowPitch = 9.42
    
    detected_answers = {}
    item_breakdown = []
    raw_score = 0
    total_points = 0
    
    for item in items:
        item_no = int(item.get('itemNo', 1))
        pts = int(item.get('points', 1))
        correct_ans = str(item.get(target_key, '')).upper().strip()
        q_type = item.get('type', 'MCQ')
        
        col_idx = (item_no - 1) // 25
        row_idx = (item_no - 1) % 25
        
        if col_idx >= len(colXs): continue
        
        cy = int(rowStartY + row_idx * rowPitch)
        
        # Measure pixel density inside each bubble bounds
        bubble_results = []
        options = ['A', 'B', 'C', 'D']
        
        for i, cx in enumerate(colXs[col_idx]):
            x = int(cx)
            roi = thresh[cy-4:cy+5, x-4:x+5] # 9x9 pixel bounding box
            fill_ratio = cv2.countNonZero(roi) / roi.size if roi.size > 0 else 0
            bubble_results.append({'opt': options[i], 'fill': fill_ratio})
            
        # Sort to find the darkest shaded bubble
        bubble_results.sort(key=lambda x: x['fill'], reverse=True)
        top = bubble_results[0]
        runner_up = bubble_results[1]
        
        student_ans = None
        # Threshold: Bubble must be > 30% filled, and clearly darker than the next option
        if top['fill'] > 0.30 and (top['fill'] - runner_up['fill']) > 0.15:
            student_ans = top['opt']
            
        if q_type == 'TF' and student_ans:
            student_ans = 'T' if student_ans == 'A' else 'F'
            
        is_correct = student_ans and (student_ans == correct_ans or correct_ans in ['*', 'ALL'])
        if is_correct: raw_score += pts
        
        total_points += pts
        if student_ans: detected_answers[item_no] = student_ans
        
        item_breakdown.append({
            'itemNo': item_no,
            'studentAnswer': student_ans or '(Blank)',
            'correctAnswer': correct_ans,
            'isCorrect': bool(is_correct)
        })
        
    return detected_answers, raw_score, total_points, item_breakdown