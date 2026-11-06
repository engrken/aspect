"""Regression tests for the free, explainable ASPECT bubble-review layer.

Run: python -m unittest discover -s tests -v
"""
import unittest
from pathlib import Path

import cv2

from api.omr_engine import mark_review_reason, grade_sheet_opencv


ASSETS = Path(__file__).parent / "assets"


def encode(img):
    success, data = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    if not success:
        raise ValueError("Fixture could not be encoded")
    return data.tobytes()


class LocalReviewTests(unittest.TestCase):
    def test_decision_rules_do_not_flag_clear_choices_or_clear_blanks(self):
        self.assertIsNone(mark_review_reason(55, 30, 70, False, "A", "MCQ"))
        self.assertIsNone(mark_review_reason(2, 1, 200, False, None, "MCQ"))

    def test_review_marks_are_explainable(self):
        self.assertIn("Two", mark_review_reason(60, 2, 50, True, "A,B", "MCQ"))
        self.assertIn("faint", mark_review_reason(20, 10, 125, False, "B", "MCQ"))
        self.assertIn("erased", mark_review_reason(15, 3, 140, False, None, "MCQ"))
        self.assertIn("True/False", mark_review_reason(50, 30, 60, False, "C", "TF"))

    def test_integration_doubles_are_flagged_without_credit(self):
        for count in (50, 100):
            with self.subTest(count=count):
                image = cv2.imread(str(ASSETS / ("sheet_50.png" if count == 50 else "sheet_100.png")),
                                   cv2.IMREAD_GRAYSCALE)
                self.assertIsNotNone(image)
                xs = (56, 72) if count == 50 else (46, 58)
                for x in xs:
                    cv2.circle(image, (x, 136), 5 if count == 50 else 4, 0, -1)
                items = [dict(itemNo=i, setA="A", setB="A", points=1, type="MCQ")
                         for i in range(1, count + 1)]
                answers, score, _, breakdown, _, _, _ = grade_sheet_opencv(encode(image), items, "A")
                self.assertEqual(score, 0)
                self.assertTrue(breakdown[0]["reviewRequired"])
                self.assertFalse(breakdown[0]["reviewed"])
                self.assertEqual(breakdown[0]["scanAnswer"], "A,B")

if __name__ == "__main__":
    unittest.main()
