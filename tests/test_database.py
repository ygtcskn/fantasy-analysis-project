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


if __name__ == "__main__": unittest.main()
