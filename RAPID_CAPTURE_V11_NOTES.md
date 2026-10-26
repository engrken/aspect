# ASPECT v11 — Reactive auto-capture

This change only updates the scanner client, its browser test, and the teacher-scanner UI copy. It does not alter the answer sheet, database, marking keys, or API.

## Behavior
- No 1.8-second camera-start countdown.
- Probes the live video approximately every 170 ms while the scanner is visible.
- Requires all **four outer corner squares** to be detected in three successive sharp, position-stable frames (normally about half a second; performance and autofocus vary).
- Position stability requires less than six pixels of corner drift at a 640-pixel probe width.
- Rejects obviously low-detail **live preview frames** before taking an automatic photograph. The server's existing full-resolution blur and registration checks remain authoritative.
- A successful grade still requires staff confirmation with **Save Grade to Roster**. **No grades are auto-saved** by this PR.
- After a save, automatic scanning remains disarmed until the previous sheet's four corner markers disappear from the preview in two successive probes. This prevents repeatedly capturing the same paper. Manual **Scan & Grade Sheet** remains usable at any time.

## Throughput goal
Position paper → marker/focus detection → high-resolution capture → OpenCV grade → inspect → Save Grade to Roster → remove paper → position next paper. No fixed five-second delay. Final capture-to-grade latency still depends on the device's still-photo API and network/server response times.

## Verification
- V8 mock scanner check: source compilation, focus gating, 3-frame capture, duplicate-sheet lock, and next-sheet rearm — passed.
- `tests/test_capture_browser.js` now tests the same state machine using the existing Node browser mock. Run locally:

```bash
node --check public/scanner.js
node tests/test_capture_browser.js
python -m unittest discover -s tests -v
```

These commands have **not yet been run in local Node/Python in this revision**.

## Before deploying for real grading
1. Test on the actual Android phone, with autofocus active, with a printed 50-item and 100-item sheet under bright indirect lighting.
2. Test four corners visible, corner missing, deliberate movement, soft focus, and tilted paper. Confirm no score appears for a rejected image.
3. With one saved sheet still in view, check that auto-capture remains locked. Remove the paper for at least two probe cycles before the next scan.
4. Scan a few known-answer sheets, compare with manual checking and with the corrected-photo preview, and confirm every student ID/test set.
5. Check network errors and camera interruptions before attempting a large batch.

## Limitation / follow-up
The current workflow still has a manual Save Grade step for every sheet. A separate **Batch Auto-Save** feature would require explicit student/QR confidence checks, duplicate protection at the server, and a review queue for unclear responses. It is not included here to avoid changing recorded grades unexpectedly.
