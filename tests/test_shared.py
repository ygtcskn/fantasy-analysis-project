"""The rules every pipeline stage shares, and agreement with the website's copy."""
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import tempfile
import unittest

from src import shared

ROOT = Path(__file__).resolve().parents[1]


class StateTests(unittest.TestCase):
    def test_lists_match_the_website(self):
        script = (ROOT / "src/web/core/match-rules.js").read_text(encoding="utf-8")
        for name, expected in (("FINISHED_STATES", shared.FINISHED_STATES),
                               ("UNPLAYED_STATES", shared.UNPLAYED_STATES)):
            found = re.search(rf"const {name} = new Set\(\[([^\]]*)\]\)", script)
            self.assertIsNotNone(found, name)
            self.assertEqual(set(re.findall(r'"([A-Z_]+)"', found[1])), set(expected), name)

    def test_played_is_finished_without_awarded_results(self):
        self.assertEqual(shared.PLAYED_STATES, shared.FINISHED_STATES - {"AWARDED", "WO"})
        self.assertTrue(shared.is_finished({"state": "AWARDED"}))
        self.assertFalse(shared.is_played({"state": "AWARDED"}))

    def test_developer_name_wins_and_case_is_ignored(self):
        self.assertEqual(shared.fixture_state({"state.developer_name": "ft", "state": "NS"}), "FT")

    def test_unknown_or_live_states_are_in_progress(self):
        self.assertTrue(shared.in_progress({"state": "INPLAY_2ND_HALF"}))
        self.assertTrue(shared.in_progress({"state": ""}))
        for state in ("FT", "AWARDED", "NS", "POSTPONED", "CANCELLED"):
            self.assertFalse(shared.in_progress({"state": state}), state)


class NumberTests(unittest.TestCase):
    def test_a_blank_is_not_a_zero(self):
        for value in ("", "  ", None, "x", "inf", "nan", True):
            self.assertIsNone(shared.number(value), value)
        self.assertEqual(shared.number(" 2.5 "), 2.5)

    def test_fallbacks_are_explicit(self):
        self.assertEqual(shared.number_or(""), 0.0)
        self.assertEqual(shared.number_or("x", -1), -1)
        self.assertEqual(shared.integer_or("3.9"), 3)
        self.assertEqual(shared.integer_or("inf", -1), -1)

    def test_a_blank_count_is_zero_only_on_a_covered_match(self):
        self.assertEqual(shared.counted({"goals": "", "passes": "30"}, "goals"), 0.0)
        self.assertIsNone(shared.counted({"goals": "", "passes": ""}, "goals"))
        self.assertIsNone(shared.counted({"passes": "30"}, "goals"))


class SeasonTests(unittest.TestCase):
    def test_both_spellings(self):
        self.assertEqual(shared.season_folder("2026/2027"), "2026-2027")
        self.assertEqual(shared.season_label("2026-2027"), "2026/2027")

    def test_bad_seasons_explain_themselves_to_argparse(self):
        for value in ("2026", "2026/2028", "26/27"):
            with self.assertRaises(ValueError):
                shared.season_folder(value)
        parser = argparse.ArgumentParser(exit_on_error=False)
        parser.add_argument("--season", type=shared.season_folder)
        with self.assertRaises(argparse.ArgumentError) as caught:
            parser.parse_args(["--season", "2026/2028"])
        self.assertIn("consecutive", str(caught.exception))


class TimeTests(unittest.TestCase):
    def test_one_written_form_and_every_read_form(self):
        moment = datetime(2026, 10, 25, 18, 30, 5, 123456, tzinfo=timezone.utc)
        self.assertEqual(shared.utc_stamp(moment), "2026-10-25T18:30:05Z")
        self.assertEqual(shared.utc_stamp(None), "")
        for text in ("2026-10-25T18:30:05Z", "2026-10-25T18:30:05+00:00",
                     "2026-10-25 18:30:05", "2026-10-25T21:30:05+03:00"):
            self.assertEqual(shared.parse_utc(text), moment.replace(microsecond=0), text)
        self.assertEqual(shared.parse_utc("2026-10-25"), datetime(2026, 10, 25, tzinfo=timezone.utc))
        self.assertEqual(shared.parse_utc(shared.utc_stamp(moment)) - moment, timedelta(microseconds=-123456))

    def test_unreadable_times(self):
        with self.assertRaises(ValueError):
            shared.parse_utc("yesterday")
        self.assertIsNone(shared.parse_utc("", required=False))


class CsvTests(unittest.TestCase):
    def test_round_trip_keeps_text_and_leaves_no_temporary(self):
        with tempfile.TemporaryDirectory() as name:
            target = Path(name) / "nested" / "table.csv"
            shared.write_csv(target, [{"name": "Beşiktaş, \"İstanbul\"", "goals": 0}, {"goals": 2, "name": "x"}])
            shared.write_csv(target, [{"name": "Göztepe", "goals": 1}])
            self.assertEqual(shared.read_csv(target), [{"name": "Göztepe", "goals": "1"}])
            self.assertEqual([path.name for path in target.parent.iterdir()], ["table.csv"])

    def test_a_key_outside_the_columns_is_an_error(self):
        with tempfile.TemporaryDirectory() as name:
            with self.assertRaises(ValueError):
                shared.write_csv(Path(name) / "table.csv", [{"a": 1, "b": 2}], ["a"])

    def test_missing_files(self):
        with tempfile.TemporaryDirectory() as name:
            self.assertEqual(shared.read_csv(Path(name) / "absent.csv"), [])
            with self.assertRaises(FileNotFoundError):
                shared.read_csv(Path(name) / "absent.csv", required=True)


if __name__ == "__main__":
    unittest.main()
