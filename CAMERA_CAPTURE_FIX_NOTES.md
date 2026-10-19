# ASPECT — Phone camera clarity and skew correction (v10)

**Project:** ASPECT (independent from CLEAR). This package builds upon the earlier corrected ASPECT scanner. No changes to the database schema, answer-sheet printer, or authentication have been made in this update.

## Why the old captured image looked worse than the preview

1. The video feed was constrained to 1280 × 960 (ideal), and the captured frame was capped at 1600px wide, even if the device could supply a higher-resolution still photo.
2. The JavaScript camera code used JPEG quality 0.82, potentially softening small answer bubbles, QR modules, and lettering.
3. Automatic capture triggered after only two corner-detection samples 150 milliseconds apart; autofocus and motion could still be settling.
4. OpenCV returned only a 400px-wide warped image as the final preview, regardless of how sharp the original was. Enlarging that small preview on a smartphone or laptop makes it appear blurry.

## Changes in this package

- `public/scanner.js`
  - Requests a high-detail rear-facing video track with device-compatible fallback.
  - Uses `ImageCapture.takePhoto()` for high-resolution still images on compatible browsers, with a full-video-frame fallback.
  - Captures and uploads JPEG at quality 0.92 and limits the longer edge to 2560px to control network payload size.
  - Auto-captures only after an autofocus settling interval and five position-stable corner checks.
  - Supports a phone's native camera via a file capture control (`Phone Camera (Sharper Photo)`) for devices with low-quality browser video streams.
  - Shows a `View Original Photo` / `View Graded Sheet` toggle for comparing exactly what was captured with the aligned/scored version.
  - Correctly scales grading overlays onto the higher-resolution corrected image.
  - Optimizes client-side QR processing to prevent enormous 12MP QR canvases.
- `api/omr_engine.py`
  - Continues to grade on the established 400×450 / 400×570 coordinates so bubble positions remain unchanged.
  - **Renders the corrected photo at 1200×1350 / 1200×1710 directly from the incoming original-resolution camera frame**, avoiding a second loss of detail caused by enlarging the low-resolution OMR image.
  - Rejects significantly blurry photos before grade calculation rather than silently returning a questionable score.
- `api/index.py`
  - Updates the API grading result to unpack the seven-value OMR response and return `detectedTestSet`, preventing scanning failure and preserving correct Set A/B submissions.
- `public/teacher.html`
  - Adds phone camera and original/graded image controls, maintains correct image aspect ratio, displays source camera resolution, and updates scanner JavaScript cache key to `v=10`.

## Tests

From the root of `ASPECT`:

```sh
python -m unittest discover -s tests -v
node tests/test_capture_browser.js
node --check public/scanner.js
```

The Python regression suite verifies 50- and 100-item forms, perspective correction, Set B, double marks, missing markers, defocused-photo rejection, and high-resolution preview output. The Node test uses a mocked browser to exercise the capture and preview UI. **Tests do not emulate real iOS/Android autofocus, image orientation, or native OS photo capture.**

## Deploy the fix safely

1. Back up the independent ASPECT repository and database.
2. Extract `ASPECT_Camera_Clarity_Patch.zip` into the repository root so the four changed source files overwrite their counterparts: `public/scanner.js`, `public/teacher.html`, `api/omr_engine.py`.
3. Deploy ASPECT to Vercel and hard-refresh the teacher dashboard. Verify the page loads `scanner.js?v=10`.
4. Open **Live Scanner** from a phone and observe the listed **Live camera** resolution.
5. In bright diffuse light, lay one printed sheet flat. Position the phone nearly perpendicular to the sheet so all six black registration squares are visible.
6. Try automatic scanning. If the live stream remains soft or blurry, select **Phone Camera (Sharper Photo)** to take a full-resolution photo with the phone's native camera app instead.
7. After grading, compare **View Original Photo** and **View Graded Sheet**. Verify five deliberately shaded known answers, the test set, and the student before pressing **Save Grade to Roster**.
8. Retest a 50-item sheet, a 100-item sheet, a skewed sheet, and one deliberately out-of-focus photo (it should be rejected).

## Important limitations

- A web app cannot guarantee the phone will expose its best camera mode through `getUserMedia`. The *Phone Camera* option uses the operating system's camera experience where the browser supports `capture=environment`.
- Perspective correction can straighten a sharp tilted photo but cannot recreate missing detail from severe motion blur or poor focus.
- The expanded corrected preview preserves available camera detail; it does **not** magically sharpen an image captured with a low-resolution feed.
- The backend rejects significantly blurry images using a Laplacian-based heuristic tuned on generated sample sheets. Validate with real printed sheets and actual devices before grading students; edge cases could require further threshold calibration.
- The original photo is for review in the browser only; the existing saved-grade flow still stores the corrected sheet preview as before.
- The phone camera has not been exercised on the user's actual device in this environment.