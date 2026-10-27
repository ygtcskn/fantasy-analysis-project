"""The hourly update's optional steps: a failed forecast or TFF export never blocks the site."""
from datetime import timedelta
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

from src import update_site
from src.shared import utc_now, utc_stamp, write_csv


class TffDueTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.players = Path(directory.name) / "tff_players.csv"
        self.settings = {"TFF_FANTASY_EMAIL": "someone@example.com", "TFF_FANTASY_PASSWORD": "secret"}
        for name, value in (("TFF_PLAYERS", self.players),
                            ("local_setting", lambda key: self.settings.get(key, ""))):
            patcher = mock.patch.object(update_site, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.now = utc_now()

    def table(self, hours_ago):
        write_csv(self.players, [{"player_name": "A", "updated_at_utc": utc_stamp(self.now - timedelta(hours=hours_ago))}])

    def run_row(self, hours_ago, steps="download pipeline build upload", message=""):
        return {"started_at_utc": utc_stamp(self.now - timedelta(hours=hours_ago)), "steps": steps, "message": message}

    def test_needs_both_login_settings(self):
        self.table(48)
        del self.settings["TFF_FANTASY_PASSWORD"]
        self.assertFalse(update_site.tff_due([], self.now))

    def test_a_fresh_table_waits_and_a_stale_or_missing_one_runs(self):
        self.assertTrue(update_site.tff_due([], self.now))
        self.table(2)
        self.assertFalse(update_site.tff_due([], self.now))
        self.table(30)
        self.assertTrue(update_site.tff_due([], self.now))

    def test_one_attempt_a_day_whether_it_failed_or_not(self):
        self.table(30)
        failed = self.run_row(3, "download pipeline build upload", "tff failed: exit code 1")
        self.assertFalse(update_site.tff_due([failed], self.now))
        self.assertFalse(update_site.tff_due([self.run_row(3, "download tff pipeline build upload")], self.now))
        self.assertTrue(update_site.tff_due([self.run_row(25, "download", "tff failed: exit code 1")], self.now))


class OptionalStepTests(unittest.TestCase):
    def test_a_failed_step_is_recorded_and_the_update_carries_on(self):
        warnings = []
        with tempfile.TemporaryFile("w+", encoding="utf-8") as log:
            done = update_site.run_optional("odds", [sys.executable, "-c", "raise SystemExit(3)"], log, None, warnings)
        self.assertFalse(done)
        self.assertEqual(warnings, ["odds failed: exit code 3"])

    def test_a_successful_step_reports_done(self):
        warnings = []
        with tempfile.TemporaryFile("w+", encoding="utf-8") as log:
            done = update_site.run_optional("odds", [sys.executable, "-c", "pass"], log, None, warnings)
        self.assertTrue(done)
        self.assertEqual(warnings, [])


if __name__ == "__main__":
    unittest.main()
