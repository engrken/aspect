# aspect development instructions

aspect contains a Python FastAPI/OpenCV backend and static browser pages.

Preserve camera permission handling, capture alignment and browser fallback behavior. Use synthetic sheet fixtures rather than real student records. Check the API and static frontend together when changing capture payloads. Do not claim recognition accuracy or physical camera validation from static checks.

## Working practice

- Read existing code and applicable AGENTS.md files before editing. Keep changes focused and preserve unrelated work.
- Use the repository's existing dependencies and package manager. Do not invent test commands.
- Never print or commit credentials, environment files, personal student/customer data or production database exports.
- Prefer focused local checks. Batch changes to conserve CI and deployment quotas. Do not start cloud builds, deployments or migrations solely to validate documentation or development configuration.
- State what was actually verified and what remains untested. Successful compilation is not proof of live service or hardware correctness.
- GitHub Education entitlements belong to the eligible account/organization; repository configuration does not redeem benefits or supply public SaaS inference credits.

## Setup and validation

Review tests/test_scanner_alignment.py and tests/test_capture_browser.js before selecting runtime checks. Container provides Python 3.11 to suit the pinned NumPy/OpenCV requirements. Existing Vercel routing is not reproduced by a generic static server.

See GITHUB_EDUCATION.md for cloud development and activation steps.
