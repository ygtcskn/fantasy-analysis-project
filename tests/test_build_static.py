"""The public site's _headers file: the browser protections every page is sent."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.web.build_static import BUILD_MARK, content_security_policy, headers_file, supabase_origin  # noqa: E402

SUPABASE = "https://example.supabase.co"


class HeadersFile(unittest.TestCase):
    def test_supabase_origin_is_read_from_the_published_auth_config(self):
        code = {"core/auth-config.js": b'const SITE_AUTH = {\n  url: "https://example.supabase.co/rest/v1/",\n  key: "k",\n};'}
        self.assertEqual(supabase_origin(code), SUPABASE)
        self.assertEqual(supabase_origin({"core/auth-config.js": b'const SITE_AUTH = { url: "", key: "" };'}), "")
        self.assertEqual(supabase_origin({}), "")

    def test_this_projects_auth_config_is_understood(self):
        code = {"core/auth-config.js": (ROOT / "src" / "web" / "core" / "auth-config.js").read_bytes()}
        self.assertRegex(supabase_origin(code), r"^https://[a-z0-9]+\.supabase\.co$")

    def test_policy_allows_only_what_the_pages_use(self):
        policy = dict(part.split(" ", 1) for part in content_security_policy(SUPABASE).split("; "))
        self.assertEqual(policy["default-src"], "'self'")
        self.assertEqual(policy["script-src"], "'self' https://cdn.jsdelivr.net https://static.cloudflareinsights.com")
        self.assertNotIn("unsafe-inline", policy["script-src"])
        self.assertNotIn("unsafe-eval", policy["script-src"])
        self.assertEqual(policy["img-src"], f"'self' {SUPABASE}")
        self.assertIn(SUPABASE, policy["connect-src"].split())
        self.assertIn("wss://example.supabase.co", policy["connect-src"].split())
        self.assertEqual(policy["frame-ancestors"], "'none'")
        self.assertEqual(policy["object-src"], "'none'")

    def test_policy_without_sign_in_names_no_supabase(self):
        policy = content_security_policy("")
        self.assertNotIn("supabase", policy)
        self.assertIn("img-src 'self';", policy)

    def test_headers_file_keeps_its_mark_and_sends_the_protections(self):
        text = headers_file("2026-2027", "abc1234", SUPABASE)
        self.assertTrue(text.startswith(BUILD_MARK + "\n/*\n"))
        everywhere, data = text.split("/local-data/*\n")
        for header in ("X-Site-Code: abc1234", "X-Content-Type-Options: nosniff",
                       "Strict-Transport-Security: max-age=31536000", "X-Frame-Options: DENY",
                       "Permissions-Policy: camera=(), microphone=(), geolocation=()",
                       f"Content-Security-Policy: {content_security_policy(SUPABASE)}"):
            self.assertIn(f"  {header}\n", everywhere)
        self.assertIn("  X-Superlig-Season: 2026-2027\n", data)
        # Cloudflare Pages ignores a header line longer than 2,000 characters.
        self.assertTrue(all(len(line) <= 2000 for line in text.splitlines()))


if __name__ == "__main__":
    unittest.main()
