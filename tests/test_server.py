import json
import tempfile
import threading
import unittest
import urllib.request
from datetime import timedelta
from pathlib import Path

from server import AppError, AppServer, CodePoolApp, iso_utc, utc_now


class CodePoolTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = CodePoolApp(Path(self.temp.name) / "test.sqlite3", admin_password="test-password")
        with self.app.connect() as db:
            self.activity_id = db.execute("SELECT id FROM activities LIMIT 1").fetchone()["id"]
            db.execute(
                "UPDATE activities SET status='published',starts_at=?,ends_at=? WHERE id=?",
                (iso_utc(utc_now() - timedelta(hours=1)), iso_utc(utc_now() + timedelta(days=2)), self.activity_id),
            )
            self.scope_id = db.execute(
                "SELECT id FROM scopes WHERE activity_id=? ORDER BY id LIMIT 1", (self.activity_id,)
            ).fetchone()["id"]
            self.tier_id = db.execute(
                "SELECT id FROM tiers WHERE activity_id=? ORDER BY id DESC LIMIT 1", (self.activity_id,)
            ).fetchone()["id"]

    def tearDown(self):
        self.temp.cleanup()

    def identity(self, suffix: str, ip: str = "127.0.0.1"):
        return self.app.identity(f"visitor-{suffix}-0000000000000000", ip)

    def submit(self, code: str, visitor="submitter", ip="10.0.0.1"):
        return self.app.submit_code(
            self.activity_id,
            {
                "code": code,
                "reward_value": 614,
                "scope_id": self.scope_id,
                "terms_accepted": True,
            },
            self.identity(visitor, ip),
        )

    def reserve(self, visitor: str, ip: str):
        return self.app.reserve_claim(
            self.activity_id,
            {"tier_id": self.tier_id, "scope_id": self.scope_id, "notice_accepted": True},
            self.identity(visitor, ip),
        )

    def test_bootstrap_and_public_activity(self):
        bootstrap = self.app.bootstrap()
        self.assertEqual(len(bootstrap["activities"]), 1)
        self.assertEqual(bootstrap["activities"][0]["public_state"], "active")
        activity = self.app.public_activity(self.activity_id)["activity"]
        self.assertEqual(activity["code_capacity"], 10)
        self.assertEqual(len(activity["tiers"]), 3)

    def test_submit_is_normalized_deduplicated_and_starts_at_ten(self):
        result = self.submit("  good-code  ")
        self.assertEqual(result["remaining"], 10)
        with self.app.connect() as db:
            row = db.execute("SELECT code_value,remaining,status FROM codes WHERE id=?", (result["id"],)).fetchone()
            self.assertEqual(row["code_value"], "GOOD-CODE")
            self.assertEqual(row["remaining"], 10)
            self.assertEqual(row["status"], "pending")
        with self.assertRaises(AppError) as raised:
            self.submit("GOOD-CODE", visitor="other", ip="10.0.0.2")
        self.assertEqual(raised.exception.code, "duplicate_code")

    def test_cancelled_copy_releases_capacity(self):
        self.submit("CANCEL-ME")
        claim = self.reserve("claimer-one", "10.0.1.1")
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT remaining FROM codes").fetchone()["remaining"], 9)
        result = self.app.cancel_claim(claim["claim_id"], claim["claim_token"])
        self.assertTrue(result["released"])
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT remaining FROM codes").fetchone()["remaining"], 10)

    def test_confirmed_claim_consumes_once(self):
        self.submit("CONFIRM-ME")
        claim = self.reserve("claimer-one", "10.0.1.1")
        self.app.confirm_claim(claim["claim_id"], claim["claim_token"])
        self.app.confirm_claim(claim["claim_id"], claim["claim_token"])
        with self.app.connect() as db:
            row = db.execute("SELECT remaining FROM codes").fetchone()
            state = db.execute("SELECT state FROM claims").fetchone()
            self.assertEqual(row["remaining"], 9)
            self.assertEqual(state["state"], "confirmed")

    def test_two_distinct_invalid_reports_pause_code(self):
        self.submit("REPORT-ME")
        first = self.reserve("claimer-one", "10.0.1.1")
        self.app.confirm_claim(first["claim_id"], first["claim_token"])
        self.app.feedback(first["claim_id"], first["claim_token"], "invalid")
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT status FROM codes").fetchone()["status"], "pending")
        second = self.reserve("claimer-two", "10.0.1.2")
        self.app.confirm_claim(second["claim_id"], second["claim_token"])
        result = self.app.feedback(second["claim_id"], second["claim_token"], "invalid")
        self.assertEqual(result["code_status"], "paused")

    def test_success_feedback_verifies_code(self):
        self.submit("VERIFY-ME")
        claim = self.reserve("claimer-one", "10.0.1.1")
        self.app.confirm_claim(claim["claim_id"], claim["claim_token"])
        result = self.app.feedback(claim["claim_id"], claim["claim_token"], "success")
        self.assertEqual(result["code_status"], "verified")

    def test_browser_daily_claim_limit(self):
        self.submit("LIMIT-ONE", visitor="source-1", ip="10.0.2.1")
        self.submit("LIMIT-TWO", visitor="source-2", ip="10.0.2.2")
        self.submit("LIMIT-THREE", visitor="source-3", ip="10.0.2.3")
        first = self.reserve("limited-user", "10.0.3.1")
        self.app.confirm_claim(first["claim_id"], first["claim_token"])
        second = self.reserve("limited-user", "10.0.3.1")
        self.app.confirm_claim(second["claim_id"], second["claim_token"])
        with self.assertRaises(AppError) as raised:
            self.reserve("limited-user", "10.0.3.1")
        self.assertEqual(raised.exception.code, "claim_limit")

    def test_owner_can_list_and_withdraw(self):
        result = self.submit("OWNER-CODE")
        items = self.app.my_submissions([result["owner_token"]])
        self.assertEqual(items[0]["id"], result["id"])
        self.app.withdraw_code(result["id"], result["owner_token"])
        with self.app.connect() as db:
            self.assertEqual(db.execute("SELECT status FROM codes WHERE id=?", (result["id"],)).fetchone()["status"], "withdrawn")

    def test_admin_login_and_settings(self):
        token = self.app.admin_login("test-password")
        self.assertTrue(self.app.admin_authenticated(token))
        self.app.save_settings({"site_name": "测试互助", "sponsor_enabled": True})
        self.assertEqual(self.app.bootstrap()["settings"]["site_name"], "测试互助")
        self.app.admin_logout(token)
        self.assertFalse(self.app.admin_authenticated(token))

    def test_activity_metadata_can_change_without_orphaning_existing_codes(self):
        self.submit("KEEP-TIER")
        activity = self.app.admin_dashboard()["activities"][0]
        activity["summary"] = "更新后的活动摘要"
        self.app.save_activity(activity, self.activity_id)
        with self.app.connect() as db:
            code = db.execute("SELECT tier_id,scope_id FROM codes WHERE code_value='KEEP-TIER'").fetchone()
            self.assertIsNotNone(code["tier_id"])
            self.assertIsNotNone(code["scope_id"])
        activity["tiers"][0]["name"] = "改变档位"
        with self.assertRaises(AppError) as raised:
            self.app.save_activity(activity, self.activity_id)
        self.assertEqual(raised.exception.status, 409)


class HttpSmokeTest(unittest.TestCase):
    def test_static_and_api_are_served(self):
        with tempfile.TemporaryDirectory() as temp:
            app = CodePoolApp(Path(temp) / "http.sqlite3", admin_password="test")
            server = AppServer(("127.0.0.1", 0), app)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/") as response:
                    self.assertEqual(response.status, 200)
                    self.assertIn("峡谷口令互助", response.read().decode("utf-8"))
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/bootstrap") as response:
                    payload = json.loads(response.read().decode("utf-8"))
                    self.assertIn("activities", payload)
                    self.assertIn("settings", payload)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
