import os
import re
import unittest

os.environ["ASPECT_OTP_SECRET"] = "unit-test-secret-that-is-at-least-32-bytes-long"

from api.index import email_delivery_configured, generate_otp, otp_digest


class OTPAuthHelperTests(unittest.TestCase):
    def test_generated_code_is_six_digits(self):
        for _ in range(100):
            self.assertRegex(generate_otp(), r"^\\d{6}$")

    def test_digest_is_stable_and_account_bound(self):
        digest = otp_digest("student-001", "123456")
        self.assertEqual(digest, otp_digest("STUDENT-001", "123456"))
        self.assertNotEqual(digest, otp_digest("student-002", "123456"))
        self.assertNotEqual(digest, otp_digest("student-001", "654321"))

    def test_digest_requires_long_secret(self):
        previous = os.environ["ASPECT_OTP_SECRET"]
        try:
            os.environ["ASPECT_OTP_SECRET"] = "short"
            with self.assertRaises(RuntimeError):
                otp_digest("student-001", "123456")
        finally:
            os.environ["ASPECT_OTP_SECRET"] = previous

    def test_email_delivery_requires_authenticated_tls_settings(self):
        keys = ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM_EMAIL")
        previous = {key: os.environ.get(key) for key in keys}
        try:
            for key in keys:
                os.environ.pop(key, None)
            self.assertFalse(email_delivery_configured())
            for key in keys:
                os.environ[key] = "configured"
            self.assertTrue(email_delivery_configured())
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


if __name__ == "__main__":
    unittest.main()
