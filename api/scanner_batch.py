"""Pure grading and batch safety helpers shared by scanner endpoints.

This module deliberately has no database dependencies, so safety rules can be
tested without connecting to the production classroom database.
"""

def canonical_student_id(value):
    return str(value or "").strip().upper()


def derive_review_reasons(breakdown, qr_id, set_mark_detected,
                          browser_qr_id=None, known_student=True,
                          enrolled=True, duplicate=False):
    reasons = []
    def add(reason):
        if reason not in reasons:
            reasons.append(reason)

    if not qr_id:
        add("Student QR code not detected")
    elif not known_student:
        add("Student not found in roster")
    elif not enrolled:
        add("Student is not enrolled in the selected class")

    if browser_qr_id and qr_id and canonical_student_id(browser_qr_id) != canonical_student_id(qr_id):
        add("Camera QR and server QR disagree")
    if not set_mark_detected:
        add("Test-set bubble is unclear; verify Set A/B")
    if duplicate:
        add("Existing recorded submission: never overwrite automatically")

    if not breakdown:
        add("No answer items were graded")
        return reasons

    blank_count = 0
    for item in breakdown:
        answer = str(item.get("studentAnswer") or "").strip()
        if not answer or answer == "(Blank)":
            blank_count += 1
        if "," in answer:
            add("One or more questions have multiple marks")
        if item.get("reviewFlag"):
            add("One or more answer bubbles are faint or ambiguous")
    if blank_count / len(breakdown) > 0.30:
        add("Over 30% of answers appear blank")
    return reasons


def grade_answers(items, answers, test_set):
    """Recalculate every accepted result using the stored class answer key."""
    if test_set not in ("A", "B"):
        raise ValueError("Invalid test set")
    if not items:
        raise ValueError("This class has no saved answer key")
    clean = {}
    breakdown = []
    score = 0
    total = 0
    for item in items:
        number = str(int(item.item_no))
        choice = str((answers or {}).get(number, "") or "").strip().upper()
        allowed = ("T", "F", "A", "B", "C", "D")
        if choice and choice not in allowed and "," not in choice:
            raise ValueError("Invalid marked answer for question " + number)
        key = str(item.set_b if test_set == "B" else item.set_a).strip().upper()
        if item.type == "TF":
            if choice == "A":
                choice = "T"
            elif choice == "B":
                choice = "F"
        pts = int(item.points)
        total += pts
        correct = bool(choice and "," not in choice and (choice == key or key in ("*", "ALL")))
        if correct:
            score += pts
        if choice:
            clean[number] = choice
        breakdown.append({"itemNo": int(number),
                          "studentAnswer": choice or "(Blank)",
                          "correctAnswer": key, "isCorrect": correct})
    return score, total, clean, breakdown


def reconciled_breakdown(original, recalculated):
    """Preserve physical-photo bubble overlays while showing reviewed answers."""
    by_item = {str(i.get("itemNo")): i for i in (original or [])}
    output = []
    for item in recalculated:
        previous = by_item.get(str(item["itemNo"]), {})
        merged = dict(previous)
        old = str(previous.get("studentAnswer") or "(Blank)")
        merged.update(item)
        if old != item["studentAnswer"]:
            merged["manuallyCorrected"] = True
        output.append(merged)
    return output
