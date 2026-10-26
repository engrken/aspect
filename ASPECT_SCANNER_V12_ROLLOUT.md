# ASPECT Scanner v12 — Single-Rollout Release Candidate

This release candidate combines the former instant-capture PR with safe, opt-in 100-paper batch processing and instructor review. **It has not been deployed or validated with a physical Android camera. Do not merge until QA and a production database backup are complete.**

## What changes
- Reactive capture probes ~170 ms apart with **no artificial 5-second wait**.
- Requires four visible outer registration squares, three sharp/stable readings, and successful **server-side six-marker registration**.
- Uses the best supported rear-camera still photo when available (existing v10 feature), or a high-resolution video frame fallback.
- Keeps original vs corrected photograph comparison, manual capture, and OS-native phone-camera fallback.
- After scanning, waits for prior sheet to leave the camera field to prevent an accidental second capture.
- Optional **Batch Auto-Save** (OFF by default) stages every successfully graded candidate to a server-side scanner review table.
- Eligible candidates automatically become **unpublished draft grades**. QR mismatches, unknown or unenrolled students, missing test-set bubbles, too many blanks, multiple/faint marks, and duplicate grades stay in a private, persistent review queue.
- Manual review includes the aligned image, all recognized answers, a per-question correction selector, enrollment verification, confirmed exam set, and an optional audit note.
- The scoring endpoint and final save use the **server's saved answer keys**. Raw grades cannot be supplied by the browser as authoritative.
- No silent overwrite: duplicates are rejected unless an instructor explicitly confirms a replacement.
- Idempotent batch scan IDs prevent retrying the same scan from writing a second grade.
- The teacher can pause scanning, change class, start or resume batches, inspect progress, download a formula-sanitized CSV audit report, and publish a completed batch only after resolving its pending scans.
- Batch grades remain **hidden from students** until explicitly published. Existing grades are migrated to published=TRUE to preserve legacy results.
- A scan's originating ID must still match the grade being published, preventing stale batches from publishing a newer replacement.

## Data protection
- Database model adds a **scanner_review_queue** table. Records include owner, class, batch ID, processed image, responses, reasons, lifecycle state, review note, and publication audit.
- Two additive columns are introduced on exam_submissions: `is_published` (defaults TRUE for prior results) and `origin_scan_id`.
- The existing startup schema-ensure path includes additive, PostgreSQL-compatible `ADD COLUMN IF NOT EXISTS` changes. Backup and run migrations in staging before production. Do not assume migration safety without the production snapshot.
- Classroom ownership and enrollment are checked on the new scanning endpoints; class-scoped access checks were added to existing grade retrieval/override actions.
- Publication is guarded server-side and does not require a new printable answer sheet.

## Recommended 100-paper workflow
1. Select the correct subject and verify the student enrollment list, saved answer key and test-set bubbles.
2. Open **Live Scanner**, enable **Batch Auto-Save**, set paper target 100.
3. Present each sharp sheet; once the four black corner squares lock, ASPECT captures and grades without waiting five seconds. A successful auto-save adds an unpublished draft grade.
4. Remove each sheet until corners disappear from the viewfinder before presenting the next.
5. Resolve all pending items in **Pending Manual Review**. Verify paper/QR/set and edit misread answers before clicking **Approve & Save Grade**, or dismiss a bad capture and scan again.
6. Export the audit CSV and cross-check IDs/counts against the physical stack.
7. Click **Publish Verified Grades**, and confirm. Student results are visible only after this action.

## Test commands
```bash
node --check public/scanner.js
node --check public/batch_scanner.js
node tests/test_capture_browser.js
node tests/test_batch_browser.js
python -m unittest discover -s tests -v
```

GitHub Actions `.github/workflows/aspect-scanner-ci.yml` also runs these checks. At the time this note was written the connected GitHub CI jobs were reporting failure without usable test steps/logs; do not represent CI as passed.

## Mandatory preflight / release gate
- [ ] Snapshot the actual production ASPECT database; verify restore capability.
- [ ] Validate new table and the two additive columns against a staging copy of the DB.
- [ ] Resolve CI failures and obtain a green run of JavaScript, OMR, and scanner safety tests.
- [ ] Confirm Android Chrome autofocus performance, video resolution, camera permissions, and page lifecycle transitions on the actual teacher phone.
- [ ] Try 50 and 100 questions, Set A and B, identical-looking sheets, 10 rapid changes, a missing corner, weak light, shadows, a deliberately blurred photo, QR mismatch, absent QR, double marks, intentionally blank rows, a grade from the wrong class, and a saved duplicate.
- [ ] Confirm instructor preview: saved draft is visible to the teacher but NOT to student account until Publish.
- [ ] Simulate failed network request, refresh while an exception is pending, switch class during a request, pause during a request, and resume an older batch.
- [ ] Verify all 100 expected student IDs once and only once against the physical paper stack before publishing.
- [ ] Test staging preview for mobile layout and accessibility.
- [ ] Check admin/teacher credential hygiene. The existing ASPECT repository retains legacy default-password bootstrap logic; this is a security hardening item that must be addressed as part of a secure public deployment and may require an explicit administrator credential migration.

## Limitations
- Captures are reactive, not guaranteed instantaneous: real-camera autofocus, image upload, QR detection and Vercel/OpenCV compute all introduce variable latency.
- The front-end sharpness test is a heuristic; server-side OpenCV's actual registration and blur checks remain authoritative.
- Automatic grading cannot eliminate human judgment for faint or incorrect bubble marks. Exception review is required.
- An untested native phone camera may not expose the maximum sensor resolution to a browser.
- A review overlay depicts **original physical bubble detections**; any manually corrected answer is labeled separately in the saved breakdown.
- Browser-side loss before the server confirms a staged scan means that paper must be recaptured; never assume a transient status message is a committed record.
