"""Build the canonical TFF player table with Sportmonks player IDs.

The newest TFF snapshot is matched against the current Sportmonks season squad
by club and conservative name rules. Ambiguous or missing matches are reported
and never guessed. The canonical table retains every TFF row and leaves the
Sportmonks ID blank until that identity is safely matched or manually reviewed.
"""
import argparse
from datetime import datetime, timezone
from difflib import SequenceMatcher
from pathlib import Path
import re
import unicodedata

if __package__:
    from .csv_store import read_table, write_table
    from .parse_tff_table import ROOT
else:
    from csv_store import read_table, write_table
    from parse_tff_table import ROOT


def words(value):
    value = unicodedata.normalize("NFKD", str(value or "").casefold().replace("ı", "i"))
    value = "".join(char if char.isalnum() else " " for char in value
                    if not unicodedata.combining(char))
    return tuple(value.split())


def normalized(value):
    return "".join(words(value))


# These are naming differences between the two providers, not fuzzy matches.
# Unlisted club names must match after case, accent and punctuation removal.
TEAM_ALIASES = {
    normalized("Amed Sportif Faaliyetler"): normalized("Amed SK"),
    normalized("Arca Çorum FK"): normalized("Çorum FK"),
    normalized("Çaykur Rizespor"): normalized("Rizespor"),
    normalized("Corendon Alanyaspor"): normalized("Alanyaspor"),
    normalized("TÜMOSAN Konyaspor"): normalized("Konyaspor"),
}

TFF_REQUIRED = {"player_name", "team_name", "position"}
OVERRIDE_COLUMNS = ("tff_player_name", "tff_team_name", "tff_position", "sportmonks_player_id")
CANONICAL_PREFIX = (
    "sportmonks_player_id", "sportmonks_team_id", "sportmonks_team_name",
    "team_match_method", "sportmonks_display_name", "sportmonks_firstname",
    "sportmonks_lastname", "match_status", "match_method", "snapshot_file",
    "updated_at_utc",
)
REPORT_COLUMNS = (
    "snapshot_row", "tff_player_name", "tff_team_name", "tff_position",
    "match_status", "match_method", "sportmonks_player_id",
    "sportmonks_display_name", "sportmonks_firstname", "sportmonks_lastname",
    "sportmonks_team_id", "sportmonks_team_name", "team_match_method",
    "candidate_count",
)
CANDIDATE_COLUMNS = (
    "snapshot_row", "candidate_rank", "tff_player_name", "tff_team_name",
    "tff_position", "sportmonks_player_id", "sportmonks_display_name",
    "sportmonks_firstname", "sportmonks_lastname", "sportmonks_team_id",
    "sportmonks_team_name", "team_match_method", "name_similarity",
)
MATCH_PRIORITY = {
    "manual_override": 4,
    "exact_lastname": 3,
    "exact_lastname_component": 3,
    "exact_firstname": 3,
    "exact_firstname_component": 3,
    "exact_display_name": 3,
    "exact_display_name_component": 3,
    "unique_name_prefix": 2,
    "unique_name_one_edit": 1,
}


class MatchIncomplete(ValueError):
    pass


def require_columns(rows, required, label):
    if not rows:
        raise ValueError(f"{label} is empty.")
    missing = required - set(rows[0])
    if missing:
        raise ValueError(f"{label} is missing columns: {', '.join(sorted(missing))}")


def latest_snapshot(folder):
    candidates = sorted(folder.glob("players_*.csv"))
    if not candidates:
        raise ValueError(f"No players_<timestamp>.csv snapshots found in {folder}.")
    return max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name))


def override_key(name, team, position):
    return normalized(name), normalized(team), str(position or "").strip().upper()


def load_overrides(path):
    if not path.exists():
        return {}
    rows = read_table(path)
    if not rows:
        return {}
    require_columns(rows, set(OVERRIDE_COLUMNS), path.name)
    result = {}
    for number, row in enumerate(rows, 2):
        key = override_key(row["tff_player_name"], row["tff_team_name"], row["tff_position"])
        player_id = row["sportmonks_player_id"].strip()
        if not all(key):
            raise ValueError(f"{path.name} row {number} has a blank player, team or position.")
        # The generated review template intentionally leaves IDs blank. This
        # lets the user resolve entries gradually and rerun after each edit.
        if not player_id:
            continue
        if key in result and result[key] != player_id:
            raise ValueError(f"{path.name} has conflicting overrides at row {number}.")
        result[key] = player_id
    return result


def field_forms(player, field):
    """Return a full normalized name field and its normalized components."""
    parts = words(player.get(field, ""))
    return ({"".join(parts)} - {""}, set(parts)) if parts else (set(), set())


def player_name_variants(player):
    first_full, first_components = field_forms(player, "firstname")
    last_full, last_components = field_forms(player, "lastname")
    display_full, display_components = field_forms(player, "display_name")
    return (first_full | first_components | last_full | last_components
            | display_full | display_components)


def tff_name_forms(value):
    """Return the normalized complete TFF label and its final component."""
    parts = words(value)
    return ("".join(parts), parts[-1]) if parts else ("", "")


def tff_name_variants(value):
    full, final = tff_name_forms(value)
    return {full, final} - {""}


def one_edit_apart(left, right):
    """True for one insertion, deletion or substitution after normalization."""
    if left == right or abs(len(left) - len(right)) > 1:
        return False
    if len(left) == len(right):
        return sum(a != b for a, b in zip(left, right)) == 1
    shorter, longer = (left, right) if len(left) < len(right) else (right, left)
    short_index = long_index = edits = 0
    while short_index < len(shorter) and long_index < len(longer):
        if shorter[short_index] == longer[long_index]:
            short_index += 1
            long_index += 1
        else:
            edits += 1
            long_index += 1
            if edits > 1:
                return False
    return True


def similarity(queries, player):
    names = player_name_variants(player)
    return max((SequenceMatcher(None, query, name).ratio()
                for query in queries for name in names), default=0.0)


def unique_exact_match(matches, method_by_player, method):
    matches = sorted(set(matches))
    if len(matches) == 1:
        return matches[0], method_by_player.get(matches[0], method), "matched"
    if len(matches) > 1:
        return "", method, "ambiguous"
    return None


def name_match(tff_value, candidates, players):
    full_query, final_query = tff_name_forms(tff_value)
    queries = {full_query, final_query} - {""}
    exact_full, exact_component, prefixes, one_edit = [], [], [], []
    display_full_matches, display_component_matches = [], []
    full_methods, component_methods = {}, {}
    for player_id in candidates:
        first_full, first_components = field_forms(players[player_id], "firstname")
        last_full, last_components = field_forms(players[player_id], "lastname")
        names = first_full | first_components | last_full | last_components
        if full_query and full_query in last_full:
            exact_full.append(player_id)
            full_methods[player_id] = "exact_lastname"
        elif full_query and full_query in first_full:
            exact_full.append(player_id)
            full_methods[player_id] = "exact_firstname"
        if final_query and final_query in last_components:
            exact_component.append(player_id)
            component_methods[player_id] = "exact_lastname_component"
        elif final_query and final_query in first_components:
            exact_component.append(player_id)
            component_methods[player_id] = "exact_firstname_component"
        # The provider's known-as name, e.g. "Talisca" for Anderson Souza
        # Conceição. Consulted only after legal names fail, so it can rescue an
        # unmatched row but never change one the legal names already decide.
        display_full, display_components = field_forms(players[player_id], "display_name")
        if full_query and full_query in display_full:
            display_full_matches.append(player_id)
        if final_query and final_query in display_components:
            display_component_matches.append(player_id)
        names |= display_full | display_components
        if any(len(query) >= 4 and len(name) >= 4 and
               (name.startswith(query) or query.startswith(name))
               for query in queries for name in names):
            prefixes.append(player_id)
        if any(len(query) >= 4 and len(name) >= 4 and
               one_edit_apart(query, name)
               for query in queries for name in names):
            one_edit.append(player_id)
    result = unique_exact_match(exact_full, full_methods, "ambiguous_exact_full_name")
    if result:
        return result
    result = unique_exact_match(
        exact_component, component_methods, "ambiguous_exact_name_component")
    if result:
        return result
    result = unique_exact_match(
        display_full_matches, dict.fromkeys(display_full_matches, "exact_display_name"),
        "ambiguous_exact_display_name")
    if result:
        return result
    result = unique_exact_match(
        display_component_matches,
        dict.fromkeys(display_component_matches, "exact_display_name_component"),
        "ambiguous_display_name_component")
    if result:
        return result
    for method, matches in (("unique_name_prefix", prefixes),
                            ("unique_name_one_edit", one_edit)):
        unique = sorted(set(matches))
        if len(unique) == 1:
            return unique[0], method, "matched"
        if len(unique) > 1:
            return "", method, "ambiguous"
    return "", "", "unmatched"


def catalog(sportmonks_dir):
    players = read_table(sportmonks_dir / "players.csv")
    squads = read_table(sportmonks_dir / "squads.csv")
    teams = read_table(sportmonks_dir / "teams.csv")
    require_columns(players, {"id", "display_name", "firstname", "lastname"},
                    "Sportmonks players.csv")
    require_columns(squads, {"team_id", "player_id"}, "Sportmonks squads.csv")
    require_columns(teams, {"id", "name"}, "Sportmonks teams.csv")
    by_id = {row["id"]: row for row in players}
    if len(by_id) != len(players):
        raise ValueError("Sportmonks players.csv contains duplicate IDs.")
    team_ids = {}
    team_names = {}
    for row in teams:
        key = normalized(row["name"])
        if key in team_ids and team_ids[key] != row["id"]:
            raise ValueError(f"Sportmonks team name is not unique: {row['name']}")
        team_ids[key] = row["id"]
        team_names[row["id"]] = row["name"]
    squad_index = {}
    for row in squads:
        if row["player_id"] not in by_id:
            raise ValueError(f"Squad player {row['player_id']} is absent from players.csv.")
        squad_index.setdefault(row["team_id"], set()).add(row["player_id"])
    return by_id, team_ids, team_names, squad_index


def current_squads(sportmonks_dir, team_names, players):
    """Who is still at each club, from Sportmonks' current domestic squads.

    Returns None when the export predates current squads or misses a league
    team, so an incomplete download never reads as "everyone left".
    """
    path = sportmonks_dir / "current_squads.csv"
    if not path.exists():
        return None
    rows = read_table(path)
    if rows:
        require_columns(rows, {"team_id", "player_id"}, "Sportmonks current_squads.csv")
    index = {}
    for row in rows:
        # A new signing without a name record cannot be name-matched anyway.
        if row["player_id"] in players:
            index.setdefault(row["team_id"], set()).add(row["player_id"])
    return index if set(team_names) <= set(index) else None


def resolve_team(tff_name, team_ids):
    key = normalized(tff_name)
    target = TEAM_ALIASES.get(key, key)
    if target in team_ids:
        method = "team_alias" if target != key else "exact_team_name"
        return team_ids[target], method
    # Sponsor prefixes may change. A unique suffix match is safe enough for
    # club resolution; player matching remains separately conservative.
    matches = {team_id for name, team_id in team_ids.items()
               if len(name) >= 6 and (key.endswith(name) or name.endswith(key))}
    return (next(iter(matches)), "unique_team_suffix") if len(matches) == 1 else ("", "")


def ranked_candidates(row_number, row, candidate_ids, players, team_id,
                      team_name, team_method):
    queries = tff_name_variants(row["player_name"])
    ranked = sorted(candidate_ids,
                    key=lambda player_id: (-similarity(queries, players[player_id]), player_id))
    return [{
        "snapshot_row": row_number,
        "candidate_rank": rank,
        "tff_player_name": row["player_name"],
        "tff_team_name": row["team_name"],
        "tff_position": row["position"],
        "sportmonks_player_id": player_id,
        "sportmonks_display_name": players[player_id].get("display_name", ""),
        "sportmonks_firstname": players[player_id].get("firstname", ""),
        "sportmonks_lastname": players[player_id].get("lastname", ""),
        "sportmonks_team_id": team_id,
        "sportmonks_team_name": team_name,
        "team_match_method": team_method,
        "name_similarity": f"{similarity(queries, players[player_id]):.4f}",
    } for rank, player_id in enumerate(ranked, 1)]


def match_snapshot(snapshot_rows, players, team_ids, team_names, squad_index, overrides,
                   current=None):
    """Match TFF rows to Sportmonks players.

    With ``current`` (team id -> player ids still at the club), only current
    players are candidates. A row whose name only matches a season-squad
    player who has since left is reported as ``left_league``, not as awaiting
    review, and an override pointing at a departed player is refused the same way.
    """
    matches, reports, candidate_rows = [], [], []
    for row_number, row in enumerate(snapshot_rows, 1):
        position = row["position"].strip().upper()
        team_id, team_method = resolve_team(row["team_name"], team_ids)
        team_name = team_names.get(team_id, "")
        season_ids = squad_index.get(team_id, set()) if team_id else set()
        current_ids = current.get(team_id, set()) if current is not None and team_id else None
        candidate_ids = sorted(season_ids if current_ids is None else current_ids)
        override = overrides.get(override_key(row["player_name"], row["team_name"], position), "")
        player_id = method = ""
        if override:
            if override not in players:
                raise ValueError(f"Override for {row['player_name']} references unknown Sportmonks ID {override}.")
            player_id, method, status = override, "manual_override", "matched"
        elif not team_id:
            status = "unmatched_team"
        elif not candidate_ids:
            status = "no_squad_candidates"
        else:
            player_id, method, status = name_match(
                row["player_name"], candidate_ids, players)
        if current_ids is not None:
            if status == "matched" and player_id not in current_ids:
                player_id, status = "", "left_league"
            elif status != "matched" and season_ids - current_ids:
                departed, departed_method, departed_status = name_match(
                    row["player_name"], sorted(season_ids - current_ids), players)
                if departed_status == "matched":
                    method, status = departed_method, "left_league"
        if status not in ("matched", "left_league"):
            candidate_rows.extend(ranked_candidates(
                row_number, row, candidate_ids, players, team_id,
                team_name, team_method))
        matched_player = players.get(player_id, {})
        report = {
            "snapshot_row": row_number,
            "tff_player_name": row["player_name"],
            "tff_team_name": row["team_name"],
            "tff_position": position,
            "match_status": status,
            "match_method": method,
            "sportmonks_player_id": player_id,
            "sportmonks_display_name": matched_player.get("display_name", ""),
            "sportmonks_firstname": matched_player.get("firstname", ""),
            "sportmonks_lastname": matched_player.get("lastname", ""),
            "sportmonks_team_id": team_id,
            "sportmonks_team_name": team_name,
            "team_match_method": team_method,
            "candidate_count": len(candidate_ids),
        }
        reports.append(report)
        matches.append(player_id)

    assignments = {}
    for index, player_id in enumerate(matches):
        if player_id:
            assignments.setdefault(player_id, []).append(index)
    for player_id, indexes in assignments.items():
        if len(indexes) < 2:
            continue
        best_priority = max(MATCH_PRIORITY.get(reports[index]["match_method"], 0)
                            for index in indexes)
        winners = [index for index in indexes
                   if MATCH_PRIORITY.get(reports[index]["match_method"], 0) == best_priority]
        for index in indexes:
            if len(winners) == 1 and index == winners[0]:
                continue
            report = reports[index]
            report["match_status"] = (
                "duplicate_sportmonks_id" if index in winners
                else "superseded_lower_confidence")
            matches[index] = ""
            report["sportmonks_player_id"] = ""
            report["sportmonks_display_name"] = ""
            report["sportmonks_firstname"] = ""
            report["sportmonks_lastname"] = ""
            row = snapshot_rows[index]
            candidate_ids = sorted(squad_index.get(
                report["sportmonks_team_id"], set()))
            candidate_rows.extend(ranked_candidates(
                index + 1, row, candidate_ids, players,
                report["sportmonks_team_id"],
                report["sportmonks_team_name"],
                report["team_match_method"]))
    return matches, reports, candidate_rows


def write_override_template(path, reports):
    rows = read_table(path) if path.exists() else []
    if rows:
        require_columns(rows, set(OVERRIDE_COLUMNS), path.name)
    known = {
        override_key(row["tff_player_name"], row["tff_team_name"], row["tff_position"])
        for row in rows
    }
    # Players who have left the league need no review.
    unresolved = [report for report in reports
                  if report["match_status"] not in ("matched", "left_league")]
    added = False
    for report in unresolved:
        key = override_key(
            report["tff_player_name"], report["tff_team_name"], report["tff_position"])
        if key in known:
            continue
        rows.append({
            "tff_player_name": report["tff_player_name"],
            "tff_team_name": report["tff_team_name"],
            "tff_position": report["tff_position"],
            "sportmonks_player_id": "",
        })
        known.add(key)
        added = True
    if added:
        write_table(path, rows, OVERRIDE_COLUMNS)


def update_from_snapshot(snapshot, sportmonks_dir, canonical, overrides_path,
                         report_path, candidates_path):
    snapshot_rows = read_table(snapshot)
    require_columns(snapshot_rows, TFF_REQUIRED, snapshot.name)
    collisions = set(snapshot_rows[0]) & set(CANONICAL_PREFIX)
    if collisions:
        raise ValueError(
            f"{snapshot.name} uses reserved canonical columns: "
            f"{', '.join(sorted(collisions))}")
    players, team_ids, team_names, squad_index = catalog(sportmonks_dir)
    current = current_squads(sportmonks_dir, team_names, players)
    if current is None:
        print("Current squads unavailable; matching against the whole season squad, "
              "so players who have left may still match. Rerun the downloader.")
    overrides = load_overrides(overrides_path)
    matches, reports, candidates = match_snapshot(
        snapshot_rows, players, team_ids, team_names, squad_index, overrides, current)
    write_table(report_path, reports, REPORT_COLUMNS)
    write_table(candidates_path, candidates, CANDIDATE_COLUMNS)
    unresolved = [row for row in reports if row["match_status"] not in ("matched", "left_league")]
    if unresolved:
        write_override_template(overrides_path, reports)
    assigned_ids = [row["sportmonks_player_id"] for row in reports
                    if row["match_status"] == "matched"]
    if len(set(assigned_ids)) != len(assigned_ids):
        raise MatchIncomplete("Matched Sportmonks IDs are not unique.")
    updated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    canonical_rows = []
    for row, report in zip(snapshot_rows, reports):
        player_id = report["sportmonks_player_id"]
        player = players.get(player_id, {})
        canonical_rows.append({
            **row,
            "sportmonks_player_id": player_id,
            "sportmonks_team_id": report["sportmonks_team_id"],
            "sportmonks_team_name": report["sportmonks_team_name"],
            "team_match_method": report["team_match_method"],
            "sportmonks_display_name": player.get("display_name", ""),
            "sportmonks_firstname": player.get("firstname", ""),
            "sportmonks_lastname": player.get("lastname", ""),
            "match_status": report["match_status"],
            "match_method": report["match_method"],
            "snapshot_file": snapshot.name,
            "updated_at_utc": updated,
        })
    write_table(canonical, canonical_rows, [*CANONICAL_PREFIX, *snapshot_rows[0].keys()])
    matched = sum(row["match_status"] == "matched" for row in reports)
    return len(canonical_rows), matched, len(unresolved)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--season", default="2026/2027")
    cli.add_argument("--snapshot", type=Path, help="TFF snapshot; default is newest players_*.csv")
    cli.add_argument("--canonical", type=Path,
                     default=ROOT / "data" / "final" / "tff_fantasy" / "tff_players.csv")
    cli.add_argument("--overrides", type=Path,
                     default=ROOT / "config" / "tff_player_overrides.csv")
    args = cli.parse_args()
    try:
        if not re.fullmatch(r"\d{4}/\d{4}", args.season):
            raise ValueError("Season must look like 2026/2027.")
        raw_tff_dir = ROOT / "data" / "raw" / "tff_fantasy"
        temp_tff_dir = ROOT / "data" / "temp" / "tff_fantasy"
        snapshot = args.snapshot or latest_snapshot(raw_tff_dir)
        sportmonks_dir = (ROOT / "data" / "final" / "sportmonks" /
                          args.season.replace("/", "-"))
        report = temp_tff_dir / "tff_player_match_report.csv"
        candidates = temp_tff_dir / "tff_player_match_candidates.csv"
        total, matched, unresolved = update_from_snapshot(
            snapshot, sportmonks_dir, args.canonical, args.overrides, report, candidates)
        print(f"Updated {args.canonical.resolve()}: {total} rows, "
              f"{matched} matched, {total - matched - unresolved} left the league, "
              f"{unresolved} awaiting review.")
    except (ValueError, OSError) as exc:
        cli.exit(1, f"Error: {exc}\n")


if __name__ == "__main__":
    main()
