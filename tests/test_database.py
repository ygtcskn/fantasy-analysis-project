from contextlib import closing
from pathlib import Path
import sqlite3
import tempfile
import unittest

from src.fetch.build_database import build_database, value_type
from src.fetch.csv_store import write_table


class DatabaseTests(unittest.TestCase):
    def test_type_inference_preserves_codes_and_large_integers(self):
        self.assertEqual(value_type("003"), "TEXT")
        self.assertEqual(value_type(str(2**63)), "TEXT")
        self.assertEqual(value_type("0"), "INTEGER")
        self.assertEqual(value_type("0.25"), "REAL")
        self.assertIsNone(value_type(""))

    def test_build_and_failed_rebuild_preserves_existing_database(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / "csv"
            output = Path(directory) / "season.sqlite"
            write_table(folder / "download_status.csv", [{"status": "complete"}])
            write_table(folder / "fixtures.csv", [{"fixture_id": 1, "goals": 0, "optional": None}])
            write_table(folder / "player_match_stats.csv", [{"fixture_id": 1, "player_id": 2, "xg": 0.25}])
            build_database(folder, output)
            with closing(sqlite3.connect(output)) as db:
                self.assertEqual(db.execute("SELECT goals, optional FROM fixtures").fetchone(), (0, None))
                self.assertEqual(db.execute("SELECT xg FROM player_match_stats").fetchone()[0], 0.25)
            before = output.read_bytes()
            write_table(folder / "fixtures.csv", [{"fixture_id": 1}, {"fixture_id": 1}])
            with self.assertRaises(sqlite3.IntegrityError): build_database(folder, output)
            self.assertEqual(output.read_bytes(), before)
            self.assertFalse(list(output.parent.glob("*.building.sqlite")))


class FantasyDatabaseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name) / "csv"
        self.output = Path(directory.name) / "superlig.sqlite"
        self.fantasy = Path(directory.name) / "final"
        self.season = "2026-2027"
        write_table(self.folder / "download_status.csv", [{"status": "complete"}])
        write_table(self.folder / "fixtures.csv", [{"fixture_id": 1}])
        self.paths = {
            "ledger": self.fantasy / "points" / "player_match_points.csv",
            "summary": self.fantasy / "points" / "player_season_summary.csv",
            "projections": self.fantasy / "player_projections" / self.season / "player_projections.csv",
        }
        self.rows = {
            "ledger": {"season": "2025-2026", "fixture_id": 9, "player_id": 2,
                       "points_total": 7, "pipeline_run_id": "pipeline-1"},
            "summary": {"season": "2025-2026", "player_id": 2,
                        "points_total": 7, "pipeline_run_id": "pipeline-1"},
            "projections": {"season": self.season, "fixture_id": 1, "player_id": 2,
                            "expected_points": 4.5, "pipeline_run_id": "pipeline-1"},
        }
        self.marker = self.fantasy / "fantasy_pipeline" / self.season / "pipeline_status.csv"

    def write_generation(self):
        write_table(self.marker, [{"status": "complete", "season": self.season,
                                  "pipeline_run_id": "pipeline-1"}])
        for label, path in self.paths.items():
            write_table(path, [self.rows[label]])

    def build(self):
        return build_database(self.folder, self.output, fantasy_root=self.fantasy,
                              fantasy_season="2026/2027")

    def assert_failed_rebuild_preserved(self, message):
        before = self.output.read_bytes()
        with self.assertRaisesRegex(ValueError, message):
            self.build()
        self.assertEqual(self.output.read_bytes(), before)
        self.assertFalse(list(self.output.parent.glob("*.building.sqlite")))

    def test_fantasy_import_is_opt_in_and_supports_historical_points(self):
        self.write_generation()
        counts = build_database(self.folder, self.output)
        self.assertNotIn("player_projections", counts)
        counts = self.build()
        self.assertEqual(counts["points_player_match_points"], 1)
        self.assertEqual(counts["points_player_season_summary"], 1)
        self.assertEqual(counts["player_projections"], 1)
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute(
                "SELECT season, player_id, points_total FROM points_player_match_points"
            ).fetchone(), ("2025-2026", 2, 7))
            self.assertEqual(db.execute(
                "SELECT season, expected_points, pipeline_run_id FROM player_projections"
            ).fetchone(), (self.season, 4.5, "pipeline-1"))
            self.assertEqual(db.execute(
                "SELECT rows FROM import_log WHERE file = ?",
                (f"player_projections/{self.season}/player_projections.csv",)
            ).fetchone(), (1,))

    def test_duplicate_keys_in_each_fantasy_table_preserve_existing_database(self):
        build_database(self.folder, self.output)
        for label, path in self.paths.items():
            with self.subTest(table=label):
                self.write_generation()
                write_table(path, [self.rows[label], self.rows[label]])
                self.assert_failed_rebuild_preserved("Duplicate fantasy key")

    def test_mixed_generations_in_each_fantasy_table_preserve_existing_database(self):
        build_database(self.folder, self.output)
        for label, path in self.paths.items():
            with self.subTest(table=label):
                self.write_generation()
                write_table(path, [{**self.rows[label], "pipeline_run_id": "pipeline-older"}])
                self.assert_failed_rebuild_preserved("Mixed fantasy pipeline generations")

    def test_projection_season_must_match_selected_season(self):
        build_database(self.folder, self.output)
        self.write_generation()
        write_table(self.paths["projections"], [{**self.rows["projections"], "season": "2025-2026"}])
        self.assert_failed_rebuild_preserved("Projection season mismatch")

    def test_blank_player_ids_are_rejected_in_each_fantasy_table(self):
        build_database(self.folder, self.output)
        for label, path in self.paths.items():
            with self.subTest(table=label):
                self.write_generation()
                write_table(path, [{**self.rows[label], "player_id": " "}])
                self.assert_failed_rebuild_preserved("Blank or malformed fantasy key")

    def test_fantasy_status_must_be_complete_and_identify_generation(self):
        build_database(self.folder, self.output)
        for status, run_id, message in (
            ("running", "pipeline-1", "not marked complete"),
            ("complete", "", "no pipeline_run_id"),
        ):
            with self.subTest(status=status, run_id=run_id):
                self.write_generation()
                write_table(self.marker, [{"status": status, "pipeline_run_id": run_id}])
                self.assert_failed_rebuild_preserved(message)

    def test_empty_projection_table_keeps_schema_for_completed_season(self):
        self.write_generation()
        write_table(self.paths["projections"], [], columns=self.rows["projections"].keys())
        counts = self.build()
        self.assertEqual(counts["player_projections"], 0)
        with closing(sqlite3.connect(self.output)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM player_projections").fetchone(), (0,))


if __name__ == "__main__": unittest.main()
