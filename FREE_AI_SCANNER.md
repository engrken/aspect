# ASPECT — Free local AI-assisted scanning and review (candidate release)

This branch adds **no paid AI integration, key, model hosting, or external AI API**. The
recognition pipeline uses the existing OpenCV + NumPy dependencies, supported by
an explainable, conservative uncertainty detector. This is **not a trained neural
network or an LLM**: confidence thresholds are heuristic and require real-paper
calibration. GitHub Copilot may assist developers but is **not** used to grade exams.

## Scanning workflow

1. Open the faculty dashboard, select a class with a saved answer key, and
   choose **Live Scanner**. Use the phone's rear camera where available.
2. Keep the full printed form and all registration squares visible. Automatic
   capture starts after three consistent aligned frames (nominal ~0.5 s after
   detection), without a fixed multi-second autofocus delay. Blurry or
   unreadable scans are rejected server-side; use **Phone Camera** for a sharper
   native-resolution photo when needed.
3. View the corrected sheet and item-by-item recognition results.
4. Items with multiple marks, borderline shading, possible erasures, or an
   invalid True/False mark are flagged **Review required**. A faculty member
   must explicitly choose the intended mark, blank, or invalid. Unflagged
   blanks are not automatically treated as errors.
5. The Save button stays disabled until all flagged items have been resolved.
   Recomputed preview scores use the saved answer keys and passing threshold.
6. Saving requires a valid faculty session and a class owned by that faculty
   account. Server-side scoring uses the **database's answer key**, never a key
   supplied by the browser. The existing submission record is still updated
   for a repeat scan of the same student and class.

## Compatibility and data handling

- Existing 50-item and 100-item printed forms remain unchanged.
- Existing submission database schema remains unchanged.
- Image processing is local to the application's Python server. No student
  image is forwarded to an external AI provider by this feature.
- The user's captured photo remains in browser memory; the corrected
  image and item breakdown follow ASPECT's existing grade-storage behavior.
- Human decisions are saved in the item breakdown with the original
  machine-recognized value and reason; the teacher must inspect the photo to
  make each decision.
- No assumption of zero cost for Vercel, network, or PostgreSQL usage.

## Regression checks

```bash
python -m unittest discover -s tests -v
node tests/test_capture_browser.js
node --check public/scanner.js
```

Before merging, validate on actual Android and iOS devices with printed 50-
and 100-item sheets under indoor lighting. Test clear shading, light pencil,
erasures, multiple marks, harsh reflections, skew, blur, QR/student mismatch,
exam set A/B, blank answers, and consecutive sheets. Compare every result
against a manually verified ground truth set. Review thresholds are
conservative heuristics: they are **not calibrated probabilities** or a
guarantee of correct marks.

## Release policy

Keep this branch behind a pull request until regression tests and sample-sheet
UAT pass. Do not enable unattended automatic grade saving. On a device that
cannot focus a sufficiently sharp live stream, use the native phone camera.
