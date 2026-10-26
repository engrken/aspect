"""ASPECT batch scanner safety rules independent of database and OpenCV."""
import unittest
from types import SimpleNamespace

from api.scanner_batch import (
    canonical_student_id, derive_review_reasons,
    grade_answers, reconciled_breakdown
)


class BatchSafetyTests(unittest.TestCase):
    def test_student_id_normalization(self):
        self.assertEqual(canonical_student_id(" 2026-001a "), "2026-001A")

    def test_only_verified_clear_sheet_is_auto_save_candidate(self):
        breakdown = [
            {"itemNo": n, "studentAnswer": "A", "reviewFlag": ""}
            for n in range(1, 51)
        ]
        self.assertEqual(
            derive_review_reasons(breakdown, "S01", True, browser_qr_id="S01",
                                  known_student=True, enrolled=True, duplicate=False),
            []
        )

    def test_missing_qr_uncertain_marks_missing_set_and_duplicate_are_reviewed(self):
        breakdown = [
            {"itemNo": n, "studentAnswer": "(Blank)" if n < 35 else "A",
             "reviewFlag": "Faint" if n == 47 else ""}
            for n in range(1, 51)
        ]
        breakdown[48]["studentAnswer"] = "A,B"
        reasons = derive_review_reasons(breakdown, "", False, duplicate=True)
        self.assertTrue(any("QR" in r for r in reasons))
        self.assertTrue(any("test-set" in r.lower() for r in reasons))
        self.assertTrue(any("multiple" in r for r in reasons))
        self.assertTrue(any("ambiguous" in r for r in reasons))
        self.assertTrue(any("blank" in r for r in reasons))
        self.assertTrue(any("overwrite" in r for r in reasons))

    def test_browser_and_server_qr_conflict(self):
        breakdown = [{"studentAnswer": "B"}] * 50
        reasons = derive_review_reasons(
            breakdown, "STUDENT-1", True, browser_qr_id="STUDENT-2"
        )
        self.assertIn("Camera QR and server QR disagree", reasons)

    def test_unknown_student_and_missing_enrollment(self):
        rows = [{"studentAnswer": "A"}] * 50
        self.assertTrue(derive_review_reasons(rows, "X", True, known_student=False))
        self.assertTrue(derive_review_reasons(rows, "X", True, enrolled=False))

    def test_scoring_uses_server_answer_keys_not_payload_scores(self):
        items = [
            SimpleNamespace(item_no=1, points=2, type="MCQ", set_a="A", set_b="D"),
            SimpleNamespace(item_no=2, points=3, type="TF", set_a="T", set_b="F"),
            SimpleNamespace(item_no=3, points=1, type="MCQ", set_a="B", set_b="A"),
        ]
        score, total, clean, breakdown = grade_answers(
            items, {"1": "A", "2": "A", "3": "A,B"}, "A"
        )
        self.assertEqual((score, total), (5, 6))
        self.assertEqual(clean["2"], "T")
        self.assertFalse(breakdown[2]["isCorrect"])
        score_b, _, _, _ = grade_answers(items, {"1": "D", "2": "B", "3": "A"}, "B")
        self.assertEqual(score_b, 6)

    def test_review_corrections_keep_original_overlay(self):
        original = [{"itemNo": 1, "studentAnswer": "A",
                     "bubbles": [{"x": 22, "y": 5, "state": "wrong"}]}]
        updated = [{"itemNo": 1, "studentAnswer": "B",
                    "correctAnswer": "B", "isCorrect": True}]
        merged = reconciled_breakdown(original, updated)
        self.assertTrue(merged[0]["manuallyCorrected"])
        self.assertEqual(merged[0]["bubbles"], original[0]["bubbles"])

    def test_invalid_answers_and_missing_key_rejected(self):
        item = SimpleNamespace(item_no=1, points=1, type="MCQ", set_a="C", set_b="A")
        with self.assertRaisesRegex(ValueError, "Invalid test set"):
            grade_answers([item], {"1": "A"}, "C")
        with self.assertRaisesRegex(ValueError, "Invalid marked answer"):
            grade_answers([item], {"1": "<script>"}, "A")
        with self.assertRaisesRegex(ValueError, "no saved answer key"):
            grade_answers([], {}, "A")


if __name__ == "__main__":
    unittest.main()
