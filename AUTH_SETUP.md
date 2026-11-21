# ASPECT email OTP authentication setup

The portal now uses institutional ID + email OTP for both students and faculty.

## Required Vercel environment variables

Configure these for **Preview first**, then Production after successful testing:

| Variable | Purpose |
|---|---|
| `ASPECT_OTP_SECRET` | Random secret used to HMAC OTP values before storing them. Use at least 32 characters. |
| `SMTP_HOST` | SMTP server hostname |
| `SMTP_PORT` | SMTP port; use `587` (STARTTLS) or `465` (implicit TLS) |
| `SMTP_USERNAME` | SMTP account username |
| `SMTP_PASSWORD` | SMTP credential / app password |
| `SMTP_FROM_EMAIL` | Verified sender address accepted by the SMTP provider |

Generate a strong OTP secret locally with Python:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Add the resulting value directly in Vercel's Environment Variables UI. Do not commit secrets or paste them into source control/chat.

For Gmail SMTP, use `smtp.gmail.com`, port `587`, the sending Google account as `SMTP_USERNAME`, and a Google App Password as `SMTP_PASSWORD`. The sender address must be permitted by that account. A verified transactional-email SMTP provider is also supported.

## OTP behavior

- Six-digit cryptographically generated code
- 10-minute expiration
- Five verification attempts per code
- 60-second resend cooldown
- Maximum three code requests per account in 15 minutes
- OTP digest stored in the existing `auth_sessions.otp_code` column; no new database table is required
- Successful sign-in creates an 8-hour server-side session and sets the existing Secure, HttpOnly, SameSite=Strict cookie
- Student and faculty role authorization remains server-side

The API intentionally uses a generic response for unknown IDs to avoid account enumeration. Roster email addresses must be maintained by faculty/admin; students cannot change the sign-in email from their profile without a separate verification workflow.

## Preview verification checklist

1. Configure the variables in the Vercel Preview environment.
2. Deploy the feature branch preview.
3. Request an OTP for a test student and for `FACULTY-01`; confirm delivery to the roster email.
4. Confirm an incorrect code is rejected and a correct code signs in.
5. Confirm expired codes and codes after five failed attempts are rejected.
6. Confirm resend cooldown / request throttling.
7. Confirm student sessions open the student dashboard and faculty sessions redirect to the faculty dashboard.
8. Confirm sign-out invalidates the session.
9. Only after Preview checks pass, configure Production variables and merge the reviewed PR.
