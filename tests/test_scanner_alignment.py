"""Camera-alignment regression tests using ASPECT's actual answer-sheet SVG rasterizations.

Run from project root: python -m unittest discover -s tests -v
"""
import unittest
from pathlib import Path
import sys

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from api.omr_engine import grade_sheet_opencv

ASSETS = Path(__file__).parent / 'assets'


def make_photo(image, count):
    h, w = image.shape
    source = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    target = (np.float32([[440, 100], [750, 110], [760, 550], [420, 540]])
              if count <= 50 else
              np.float32([[480, 80], [755, 95], [760, 600], [465, 590]]))
    return cv2.warpPerspective(image, cv2.getPerspectiveTransform(source, target),
                               (1280, 720), borderValue=255)


def items(count, set_a='A', set_b='A'):
    return [dict(itemNo=i, setA=set_a, setB=set_b, points=1, type='MCQ')
            for i in range(1, count + 1)]


def encoded(image):
    ok, data = cv2.imencode('.jpg', image, [int(cv2.IMWRITE_JPEG_QUALITY), 82])
    if not ok:
        raise RuntimeError('Image encoding failed')
    return data.tobytes()


class AlignmentTests(unittest.TestCase):
    def sheet(self, count):
        size = 50 if count <= 50 else 100
        img = cv2.imread(str(ASSETS / f'sheet_{size}.png'), cv2.IMREAD_GRAYSCALE)
        self.assertIsNotNone(img)
        return img

    def mark(self, img, count, option, item_no=1):
        if count <= 50:
            x = [56, 72, 88, 104]['ABCD'.index(option)]
            y = 136 + (item_no - 1) * 16
            r = 5
        else:
            x = [46, 58, 70, 82]['ABCD'.index(option)]
            y = 136 + (item_no - 1) * 16.5
            r = 4
        cv2.circle(img, (int(x), int(round(y))), r, 0, -1)

    def test_camera_perspective_preserves_bubble_coordinates(self):
        for count in (50, 60, 100):
            with self.subTest(count=count):
                image = self.sheet(count)
                for i, answer in enumerate('ABCD', start=1):
                    self.mark(image, count, answer, item_no=i)
                answer_key = [dict(itemNo=i, setA='ABCD'[(i - 1) % 4],
                                   setB='ABCD'[(i - 1) % 4], points=1, type='MCQ')
                              for i in range(1, count + 1)]
                detection, score, total, breakdown, _, preview, _ = grade_sheet_opencv(
                    encoded(make_photo(image, count)), answer_key, 'A'
                )
                self.assertEqual((score, total), (4, count))
                self.assertEqual([b['studentAnswer'] for b in breakdown[:4]], list('ABCD'))
                self.assertTrue(preview)

    def test_already_aligned_sheet_returns_preview(self):
        image = self.sheet(50)
        detection, score, _, _, _, preview, _ = grade_sheet_opencv(encoded(image), items(50), 'A')
        self.assertIsInstance(preview, str)
        self.assertTrue(len(preview) > 100)
        self.assertEqual(score, 0)

    def test_detects_shaded_set_b(self):
        for count in (50, 100):
            with self.subTest(count=count):
                image = self.sheet(count)
                cv2.circle(image, (148, 103), 5, 0, -1)
                self.mark(image, count, 'A')
                detection, score, _, breakdown, _, _, test_set = grade_sheet_opencv(
                    encoded(make_photo(image, count)), items(count, set_a='D', set_b='A'), 'A'
                )
                self.assertEqual((score, test_set), (1, 'B'))
                self.assertEqual(breakdown[0]['studentAnswer'], 'A')

    def test_double_mark_is_invalid(self):
        for count in (50, 100):
            with self.subTest(count=count):
                image = self.sheet(count)
                self.mark(image, count, 'A')
                self.mark(image, count, 'B')
                detection, score, _, breakdown, _, _, _ = grade_sheet_opencv(
                    encoded(make_photo(image, count)), items(count, 'A'), 'A'
                )
                self.assertEqual(score, 0)
                self.assertEqual(breakdown[0]['studentAnswer'], 'A,B')

    def test_blurry_photo_is_rejected_instead_of_graded(self):
        for count in (50, 100):
            with self.subTest(count=count):
                photo = make_photo(self.sheet(count), count)
                photo = cv2.GaussianBlur(photo, (5, 5), 1.3)
                with self.assertRaisesRegex(ValueError, 'Captured photo is blurry'):
                    grade_sheet_opencv(encoded(photo), items(count), 'A')

    def test_sharp_preview_uses_full_camera_photo_resolution(self):
        import base64
        for count in (50, 100):
            with self.subTest(count=count):
                sheet = self.sheet(count)
                sheet = cv2.resize(sheet, None, fx=3, fy=3, interpolation=cv2.INTER_LINEAR)
                sh, sw = sheet.shape
                src = np.float32([[0, 0], [sw-1, 0], [sw-1, sh-1], [0, sh-1]])
                target = (np.float32([[550,200], [1770,200], [1770,1650], [550,1650]])
                          if count == 50 else
                          np.float32([[550,70], [1680,90], [1660,1820], [560,1800]]))
                camera = cv2.warpPerspective(sheet, cv2.getPerspectiveTransform(src, target),
                                             (2560,1920), borderValue=255)
                _, score, _, _, _, preview_b64, _ = grade_sheet_opencv(
                    encoded(camera), items(count), 'A'
                )
                preview = cv2.imdecode(np.frombuffer(base64.b64decode(preview_b64), np.uint8),
                                       cv2.IMREAD_GRAYSCALE)
                self.assertEqual(preview.shape, (1350 if count == 50 else 1710, 1200))
                self.assertEqual(score, 0)
                self.assertLess(np.mean(preview[24:48, 24:48]), 175)

    def test_legacy_middle_markers_on_existing_printed_sheets(self):
        """Earlier printouts use Y=225/285 rather than Y=266/334 for mid marks."""
        for count in (50, 100):
            with self.subTest(count=count):
                image = self.sheet(count)
                old_mid = 266 if count == 50 else 334
                legacy_mid = 225 if count == 50 else 285
                for x in (12, 388):
                    # Only change the printed registration squares, NOT bubble
                    # locations, to match the answer sheets already in use.
                    cv2.rectangle(image, (x - 8, old_mid - 8),
                                  (x + 8, old_mid + 8), 255, -1)
                    cv2.rectangle(image, (x - 7, legacy_mid - 7),
                                  (x + 6, legacy_mid + 6), 0, -1)
                for item_no, option in enumerate('ABCD', start=1):
                    self.mark(image, count, option, item_no=item_no)
                key = [dict(itemNo=i, setA='ABCD'[(i - 1) % 4],
                            setB='ABCD'[(i - 1) % 4], points=1, type='MCQ')
                       for i in range(1, count + 1)]
                answers, score, total, breakdown, _, preview, _ = grade_sheet_opencv(
                    encoded(make_photo(image, count)), key, 'A'
                )
                self.assertEqual((score, total), (4, count))
                self.assertEqual([b['studentAnswer'] for b in breakdown[:4]], list('ABCD'))
                self.assertTrue(preview)

    def test_mixed_middle_marker_positions_are_rejected(self):
        """Do not accept a sheet with only one correctly placed middle mark."""
        image = self.sheet(100)
        cv2.rectangle(image, (4, 325), (20, 343), 255, -1)
        cv2.rectangle(image, (5, 278), (18, 291), 0, -1)
        with self.assertRaisesRegex(ValueError, 'Could not align answer sheet'):
            grade_sheet_opencv(encoded(make_photo(image, 100)), items(100), 'A')

    def test_missing_corner_raises_error(self):
        for count in (50, 100):
            with self.subTest(count=count):
                image = self.sheet(count)
                cv2.rectangle(image, (375, 0), (399, 31), 255, -1)
                with self.assertRaisesRegex(ValueError, 'Could not align answer sheet'):
                    grade_sheet_opencv(encoded(make_photo(image, count)), items(count), 'A')


if __name__ == '__main__':
    unittest.main()