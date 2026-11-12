"""Offline live-feed checks. All provider calls are mocked."""

import copy
import csv
import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from src.web import live
from src.web.serve import make_handler


def fixture(**changes):
    row = {
        "id": 100, "league_id": 600, "season_id": 2026, "state_id": 22,
        "participants": [
            {"id": 1, "name": "Ev, Takımı", "meta": {"location": "home"}},
            {"id": 2, "name": "Konuk", "meta": {"location": "away"}},
        ],
        "scores": [
            {"participant_id": 1, "description": "CURRENT", "score": {"goals": 2}},
            {"participant_id": 2, "description": "CURRENT", "score": {"goals": 0}},
            {"participant_id": 1, "description": "1ST_HALF", "score": {"goals": 1}},
        ],
        "periods": [{"ticking": True, "counts_from": 45, "period_length": 45,
                     "minutes": 92, "time_added": 5}],
        "statistics": [
            {"participant_id": 1, "type_id": 34, "data": {"value": 0}},
            {"participant_id": 2, "type_id": 34, "data": {"value": None}},
        ],
        "events": [],
    }
    row.update(changes)
    return row


def decode(content):
    return list(csv.DictReader(io.StringIO(content.decode("utf-8"))))


class LiveNormalizationTests(unittest.TestCase):
    def test_current_scores_missing_values_and_elapsed_stoppage_time(self):
        rows = decode(live.csv_bytes(live.normalize([fixture()], "600", "2026")))
        match = rows[0]
        self.assertEqual((match["home_score"], match["away_score"]), ("2.0", "0.0"))
        self.assertEqual((match["home_half_score"], match["away_half_score"]), ("1.0", ""))
        self.assertEqual((match["minute"], match["extra_minute"]), ("90.0", "2.0"))
        self.assertEqual(match["home_name"], "Ev, Takımı")
        self.assertEqual([row["value"] for row in rows if row["record_type"] == "statistic"], ["0.0", ""])

    def test_enriched_relations_are_flat_and_keep_zero_and_missing_separate(self):
        game = fixture(
            periods=[{"description": "1st-half", "minutes": 48, "ticking": False}],
            pressure=[{"participant_id": 1, "minute": 7, "pressure": 0},
                      {"participant_id": 2, "minute": 7, "pressure": 12.25},
                      {"participant_id": 3, "minute": 7, "pressure": 24},
                      {"participant_id": 1, "minute": 8, "pressure": None}],
            expected=[{"participant_id": 1, "type_id": 7944, "data": {"value": 0.2}}],
            formations=[{"participant_id": 1, "formation": "4-3-3"}],
            lineups=[{"team_id": 1, "player_id": 123, "type_id": "11", "details": [
                {"type": {"developer_name": "AERIALS_WON"}, "data": {"value": 0}},
                {"type": {"developer_name": "FOULS_DRAWN"}, "data": {"value": 1}},
                {"type": {"developer_name": "FOULS_DRAWN"}, "data": {"value": 1}},
                {"type": {"developer_name": "PASSES"}, "data": {"value": 18}},
            ]}],
        )
        match, *rows = decode(live.csv_bytes(live.normalize([game], "600", "2026")))
        for field in ("periods_available", "pressure_available", "xg_available", "formations_available", "lineups_available"):
            self.assertEqual(match[field], "1")
        period = next(row for row in rows if row["record_type"] == "period")
        self.assertEqual((period["code"], period["minute"], period["ticking"]), ("1ST_HALF", "48.0", "0"))
        self.assertEqual([(row["team_id"], row["minute"], row["value"]) for row in rows if row["record_type"] == "pressure"],
                         [("1", "7.0", "0.0"), ("2", "7.0", "12.25")])
        xg = next(row for row in rows if row["source"] == "xgfixture")
        self.assertEqual((xg["type_id"], xg["value"]), ("7944", "0.2"))
        formation = next(row for row in rows if row["record_type"] == "formation")
        self.assertEqual((formation["team_id"], formation["formation"]), ("1", "4-3-3"))
        player = next(row for row in rows if row["record_type"] == "lineup")
        self.assertEqual((player["started"], player["aerials_won"], player["fouls_drawn"], player["passes"]),
                         ("1", "0.0", "", "18.0"))

    def test_malformed_optional_relations_leave_base_result(self):
        game = fixture(pressure={"minute": 5}, formations=[None], lineups={"player_id": 123}, xgfixture="missing")
        rows = decode(live.csv_bytes(live.normalize([game], "600", "2026")))
        self.assertEqual(rows[0]["home_score"], "2.0")
        for field in ("pressure_available", "xg_available", "formations_available", "lineups_available"):
            self.assertEqual(rows[0][field], "0")

    def test_scope_and_completed_or_scheduled_games_are_excluded(self):
        fixtures = [fixture(state_id=state) for state in (1, 5, 7, 8, 10, 12, 15, 16)]
        fixtures.extend([fixture(league_id=9), fixture(season_id=2025)])
        self.assertEqual(live.normalize(fixtures, "600", "2026"), [])

    def test_halftime_and_interruptions_have_no_running_minute(self):
        for state in (3, 11, 18, 19):
            with self.subTest(state=state):
                rows = live.normalize([fixture(state_id=state)], "600", "2026")
                self.assertEqual(rows[0]["minute"], "")
                self.assertEqual(rows[0]["state"], live.STATES[state])

    def test_simultaneous_matches_and_uncertain_team_identities(self):
        rows = live.normalize([fixture(), fixture(id=101)], "600", "2026")
        self.assertEqual([row["fixture_id"] for row in rows if row["record_type"] == "fixture"], ["100", "101"])
        bad = fixture()
        bad["participants"].append(copy.deepcopy(bad["participants"][0]))
        with self.assertRaises(live.LiveUnavailable):
            live.normalize([bad], "600", "2026")
        with self.assertRaises(live.LiveUnavailable):
            live.normalize([fixture(), fixture()], "600", "2026")

    def test_duplicate_current_score_is_unknown_not_added(self):
        game = fixture()
        game["scores"].append(copy.deepcopy(game["scores"][0]))
        self.assertIsNone(live.normalize([game], "600", "2026")[0]["home_score"])

    def test_events_keep_provider_ids_var_outcome_and_order(self):
        game = fixture(events=[{"id": 91, "participant_id": 1, "player_id": 123,
                                "related_player_id": 456, "type_id": 10, "minute": 59,
                                "sort_order": 3, "addition": "Goal disallowed",
                                "type": {"developer_name": "VAR"}}])
        event = live.normalize([game], "600", "2026")[-1]
        self.assertEqual(event["team_id"], "1")
        self.assertEqual((event["player_id"], event["related_player_id"]), (123, 456))
        self.assertEqual((event["sort_order"], event["addition"]), (3, "Goal disallowed"))
        self.assertEqual(live.normalize([game], "600", "2026")[0]["home_score"], 2)

    def test_unknown_coverage_and_nested_values_never_become_json_cells(self):
        rows = decode(live.csv_bytes(live.normalize([fixture(statistics=None, events=None)], "600", "2026")))
        self.assertEqual(rows[0]["statistics_available"], "0")
        self.assertEqual(rows[0]["events_available"], "0")
        self.assertEqual(decode(live.csv_bytes([{"value": {"nested": 2}}]))[0]["value"], "")

    def test_scope_requires_one_unambiguous_league_and_season(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "fixtures.csv"
            path.write_text("league_id,season_id\n600,2026\n600,2026\n", encoding="utf-8")
            self.assertEqual(live.season_scope(root), ("600", "2026"))
            for text in ("league_id,season_id\n", "league_id,season_id\n,2026\n",
                         "league_id,season_id\n600,2026\n600,2025\n"):
                path.write_text(text, encoding="utf-8")
                with self.assertRaises(live.LiveUnavailable):
                    live.season_scope(root)


class LivePollingTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(live, "fetch_fixture_details", return_value=[])
        self.details = patcher.start()
        self.addCleanup(patcher.stop)
        enrich = patch.object(live.LiveFeed, "enrich")
        enrich.start()
        self.addCleanup(enrich.stop)

    @patch.object(live, "season_scope", return_value=("600", "2026"))
    @patch.object(live, "fetch_inplay")
    @patch.object(live.time, "monotonic", return_value=100)
    def test_disappearing_live_game_requires_confirmed_result(self, clock, fetch, scope):
        feed = live.LiveFeed(Path("2026-2027"))
        fetch.side_effect = [[fixture()], [], []]
        self.details.side_effect = [[fixture(state_id=18)], [fixture(state_id=5, lineups=[{
            "player_id": 123, "team_id": 1, "player_name": "Starter", "type_id": 11,
            "formation_field": "1:1", "position": {"name": "Goalkeeper"},
            "details": [{"type": {"developer_name": "MINUTES_PLAYED"}, "data": {"value": 90}}],
        }])]]
        feed.snapshot()
        clock.return_value = 131
        self.assertEqual(len(decode(feed.snapshot())), 1)
        clock.return_value = 192
        rows = decode(feed.snapshot())
        result = next(row for row in rows if row["record_type"] == "fixture")
        self.assertEqual((result["state"], result["home_score"], result["away_score"]), ("FT", "2.0", "0.0"))
        self.assertEqual(result["minute"], "")
        player = next(row for row in rows if row["record_type"] == "lineup")
        self.assertEqual((player["player_id"], player["started"], player["minutes_played"]), ("123", "1", "90.0"))
        self.assertEqual(player["rating"], "")
        self.details.assert_called_with(["100"])

    @patch.object(live, "season_scope", return_value=("600", "2026"))
    @patch.object(live, "fetch_inplay")
    @patch.object(live.time, "monotonic", return_value=100)
    def test_confirmed_final_with_incomplete_score_is_retried_after_backoff(self, clock, fetch, scope):
        feed = live.LiveFeed(Path("2026-2027"))
        fetch.side_effect = [[fixture()], [], [], []]
        partial = fixture(state_id=5)
        partial["scores"].pop(1)
        self.details.side_effect = [[partial], [fixture(state_id=5)]]
        feed.snapshot()

        clock.return_value = 131
        final = next(row for row in decode(feed.snapshot()) if row["record_type"] == "fixture")
        self.assertEqual((final["state"], final["home_score"], final["away_score"]), ("FT", "2.0", ""))

        clock.return_value = 192
        feed.snapshot()
        self.details.assert_called_once_with(["100"])

        clock.return_value = 253
        final = next(row for row in decode(feed.snapshot()) if row["record_type"] == "fixture")
        self.assertEqual((final["state"], final["home_score"], final["away_score"]), ("FT", "2.0", "0.0"))
        self.assertNotIn("100", feed.observed)

    @patch.object(live, "season_scope", return_value=("600", "2026"))
    @patch.object(live, "fetch_inplay")
    def test_confirmation_rejects_wrong_season_and_unrequested_fixtures(self, fetch, scope):
        feed = live.LiveFeed(Path("2026-2027"))
        fetch.side_effect = [[fixture()], []]
        self.details.return_value = [fixture(state_id=5, season_id=2025), fixture(state_id=5, id=999)]
        feed.snapshot()
        feed.next_fetch = 0
        rows = decode(feed.snapshot())
        self.assertEqual(len(rows), 1)
        self.assertEqual(feed.completed, {})

    @patch.object(live, "season_scope", return_value=("600", "2026"))
    @patch.object(live, "fetch_inplay")
    @patch.object(live.time, "monotonic", return_value=100)
    def test_confirmation_error_keeps_other_live_matches_and_backs_off(self, clock, fetch, scope):
        feed = live.LiveFeed(Path("2026-2027"))
        fetch.side_effect = [[fixture(), fixture(id=101)], [fixture(id=101)], [fixture(id=101)]]
        self.details.side_effect = live.LiveUnavailable("Unavailable", retry=300)
        feed.snapshot()
        clock.return_value = 131
        rows = decode(feed.snapshot())
        self.assertEqual(rows[0]["status"], "ok")
        self.assertEqual([row["fixture_id"] for row in rows if row["record_type"] == "fixture"], ["101"])
        clock.return_value = 162
        feed.snapshot()
        self.details.assert_called_once_with(["100"])

    @patch.object(live, "season_scope", return_value=("600", "2026"))
    @patch.object(live, "fetch_inplay")
    @patch.object(live.time, "monotonic", return_value=100)
    def test_shared_cache_finish_transition_and_error_backoff(self, clock, fetch, scope):
        feed = live.LiveFeed(Path("2026-2027"))
        fetch.side_effect = [[fixture()], [], live.LiveUnavailable("Unavailable", retry=300)]
        first = feed.snapshot()
        self.assertEqual(feed.snapshot(), first)
        fetch.assert_called_once_with("600")
        clock.return_value = 131
        empty = decode(feed.snapshot())
        self.assertEqual(len(empty), 1)
        self.assertEqual((empty[0]["status"], empty[0]["poll_seconds"]), ("ok", "60"))
        clock.return_value = 192
        error = decode(feed.snapshot())
        self.assertEqual(len(error), 1)
        self.assertEqual((error[0]["status"], error[0]["poll_seconds"]), ("unavailable", "300"))
        clock.return_value = 491
        feed.snapshot()
        self.assertEqual(fetch.call_count, 3)

    @patch.object(live, "season_scope", return_value=("600", "2026"))
    @patch.object(live, "fetch_inplay")
    def test_error_drops_previous_live_snapshot(self, fetch, scope):
        feed = live.LiveFeed(Path("2026-2027"))
        fetch.side_effect = [[fixture()], live.LiveUnavailable("Unavailable")]
        self.assertGreater(len(decode(feed.snapshot())), 1)
        feed.next_fetch = 0
        rows = decode(feed.snapshot())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["status"], "unavailable")

    @patch.object(live, "fetch_inplay")
    @patch.object(live, "token")
    def test_head_and_disabled_mode_never_load_credentials_or_call_provider(self, token, fetch):
        for feed, head in ((live.LiveFeed(Path("2026-2027"), enabled=False), False),
                           (live.LiveFeed(Path("2026-2027")), True)):
            self.assertEqual(decode(feed.snapshot(head))[0]["status"], "disabled")
        token.assert_not_called()
        fetch.assert_not_called()

    @patch.object(live, "token", return_value="test-key")
    @patch.object(live, "urlopen")
    def test_token_only_in_authorization_header_and_errors_are_sanitized(self, opening, token):
        opening.side_effect = HTTPError("https://example.invalid", 429, "test-key", {"Retry-After": "600"}, None)
        with self.assertRaises(live.LiveUnavailable) as raised:
            live.fetch_inplay("600")
        self.assertEqual(raised.exception.retry, 600)
        self.assertNotIn("test-key", str(raised.exception))
        request = opening.call_args.args[0]
        self.assertNotIn("test-key", request.full_url)
        self.assertEqual(request.get_header("Authorization"), "test-key")
        self.assertEqual(parse_qs(urlsplit(request.full_url).query)["filters"], ["fixtureLeagues:600"])

    @patch.object(live, "token", return_value="test-key")
    @patch.object(live, "urlopen")
    def test_invalid_provider_payloads_are_not_treated_as_no_live_games(self, opening, token):
        response = opening.return_value.__enter__.return_value
        for body in (b"not json", b'{"message":"unavailable"}', b'{"data":{}}',
                     b'{"data":[],"pagination":{"has_more":true}}'):
            with self.subTest(body=body):
                response.read.return_value = body
                with self.assertRaises(live.LiveUnavailable):
                    live.fetch_inplay("600")

    @patch.object(live, "LiveFeed")
    def test_local_head_uses_csv_route_without_refreshing_feed(self, feed_class):
        handler_class = make_handler(Path("2026-2027"))
        handler = object.__new__(handler_class)
        handler.server = SimpleNamespace(server_port=8000)
        handler.headers = {"Host": "localhost:8000", "Sec-Fetch-Site": "same-origin"}
        handler.path = "/local-live.csv"
        handler.send_bytes = Mock()
        handler.serve_file(head_only=True)
        feed_class.return_value.snapshot.assert_called_once_with(True)
        self.assertEqual(handler.send_bytes.call_args.args[1:], ("text/csv; charset=utf-8", True))

    @patch.object(live, "LiveFeed")
    def test_live_route_rejects_cross_site_and_foreign_hosts(self, feed_class):
        handler_class = make_handler(Path("2026-2027"))
        for host, site in (("evil.invalid:8000", "same-origin"), ("localhost:8000", "cross-site")):
            handler = object.__new__(handler_class)
            handler.server = SimpleNamespace(server_port=8000)
            handler.headers = {"Host": host, "Sec-Fetch-Site": site}
            handler.path = "/local-live.csv"
            handler.send_error = Mock()
            handler.serve_file()
            self.assertEqual(handler.send_error.call_args.args[0], 403)
        feed_class.return_value.snapshot.assert_not_called()


class LiveEnrichmentTests(unittest.TestCase):
    @patch.object(live, "fetch_fixtures")
    @patch.object(live.time, "monotonic", return_value=100)
    def test_add_on_denial_keeps_base_and_other_relations_and_backs_off(self, clock, fetch):
        def response(endpoint, params, timeout):
            self.assertEqual(endpoint, "livescores/inplay")
            self.assertEqual(params["filters"], "fixtureLeagues:600")
            self.assertEqual(timeout, live.OPTIONAL_TIMEOUT)
            if params["include"] == "xGFixture.type":
                raise live.LiveUnavailable("xG unavailable", status=403)
            if params["include"] == "pressure":
                return [fixture(season_id=2025, pressure=[{}]), fixture(pressure=[{
                    "participant_id": 1, "minute": 2, "pressure": 1,
                }])]
            return []

        fetch.side_effect = response
        feed = live.LiveFeed(Path("2026-2027"))
        game = fixture()
        feed.enrich([game], "600", "2026")
        self.assertEqual(live.normalize([game], "600", "2026")[0]["home_score"], 2)
        self.assertEqual(game["pressure"][0]["pressure"], 1)
        self.assertNotIn("xgfixture", game)
        fetch.reset_mock()
        clock.return_value += 30
        feed.enrich([fixture()], "600", "2026")
        includes = [call.args[1]["include"] for call in fetch.call_args_list]
        self.assertIn("pressure", includes)
        self.assertNotIn("xGFixture.type", includes)

    @patch.object(live, "fetch_fixtures")
    def test_final_lineups_fall_back_to_the_team_sheet_when_details_are_denied(self, fetch):
        def response(endpoint, params, timeout):
            self.assertEqual(endpoint, "fixtures/multi/100")
            if params["include"] == live.OPTIONAL_INCLUDES["lineups"]:
                raise live.LiveUnavailable("Player details unavailable", status=403)
            self.assertEqual(params["include"], "lineups")
            return [fixture(state_id=5, lineups=[{"team_id": 1, "player_id": 123, "type_id": 11}])]

        fetch.side_effect = response
        feed = live.LiveFeed(Path("2026-2027"))
        game = fixture(state_id=5, pressure=[], formations=[], xgfixture=[])
        feed.enrich([game], "600", "2026", finished=True)
        rows = live.normalize([game], "600", "2026", include_finished=True)
        self.assertEqual(rows[0]["state"], "FT")
        self.assertEqual(rows[-1]["player_id"], 123)
        self.assertEqual(fetch.call_count, 2)

    @patch.object(live, "fetch_fixtures")
    @patch.object(live.time, "monotonic", return_value=100)
    def test_optional_rate_limit_pauses_extra_requests_and_never_requests_idle_matches(self, clock, fetch):
        feed = live.LiveFeed(Path("2026-2027"))
        feed.enrich([fixture(state_id=1)], "600", "2026")
        fetch.assert_not_called()
        fetch.side_effect = live.LiveUnavailable("Rate limit", retry=600, status=429)
        feed.enrich([fixture()], "600", "2026")
        fetch.reset_mock()
        clock.return_value += 599
        feed.enrich([fixture()], "600", "2026")
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
