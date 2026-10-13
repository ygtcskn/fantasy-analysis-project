"""Build analysis-ready CSV tables from in-memory Sportmonks responses."""
from collections import defaultdict
if __package__:
    from .csv_store import scalar_fields, write_table
    from .sportmonks import metrics
else:
    from csv_store import scalar_fields, write_table
    from sportmonks import metrics


def standing_record(record):
    """Keep provider standings totals as ordinary scalar CSV columns."""
    row = scalar_fields(record)
    for detail in record.get("details") or []:
        kind = detail.get("type") or {}
        name = kind.get("developer_name")
        if name:
            values = scalar_fields(detail.get("value"), f"details.{name.lower()}")
            if row.keys() & values.keys():
                raise ValueError(f"Duplicate standing detail: {record.get('id')}/{name}")
            row.update(values)
    return row


def export_tables(folder, fixtures, resources):
    tables = defaultdict(list)
    headers = {
        "fixtures": ["fixture_id", "season_id", "kickoff", "state", "home_team_id", "away_team_id"],
        "player_match_stats": ["fixture_id", "player_id", "team_id", "name", "started", "position", "formation_field", "formation_position"],
        "player_metrics": ["fixture_id", "player_id", "team_id", "source", "type_id", "name", "value"],
        "team_metrics": ["fixture_id", "team_id", "source", "type_id", "name", "value"],
        "events": ["fixture_id", "event_id", "player_id", "team_id", "minute", "type_id"],
        "teams": ["id", "name"], "players": ["id", "display_name"],
        "squads": ["season_id", "team_id", "player_id", "jersey_number", "position_id"],
        "player_season_metrics": ["season_id", "team_id", "player_id", "type_id", "name"],
        "team_season_metrics": ["season_id", "team_id", "type_id", "name"],
        "standings": ["participant_id", "position", "points"],
        "round_standings": ["snapshot_round_id", "participant_id", "position", "points"],
        "topscorers": ["season_id", "player_id", "type_id", "position", "total"],
    }
    players = {}
    for f in fixtures.values():
        fid = f["id"]
        sides = {(p.get("meta") or {}).get("location"): p["id"] for p in f.get("participants", [])}
        row = scalar_fields(f)
        row.update(fixture_id=fid, season_id=f.get("season_id"), kickoff=f.get("starting_at"),
                   state=(f.get("state") or {}).get("developer_name", f.get("state_id")),
                   home_team_id=sides.get("home"), away_team_id=sides.get("away"))
        tables["fixtures"].append(row)
        for p in f.get("lineups") or []:
            if p.get("player"):
                players[p["player"]["id"]] = p["player"]
            row = {"fixture_id": fid, "player_id": p["player_id"], "team_id": p["team_id"],
                   "name": p.get("player_name"), "started": {11: 1, 12: 0}.get(p.get("type_id")),
                   "position": (p.get("position") or {}).get("name"),
                   "formation_field": p.get("formation_field"),
                   "formation_position": p.get("formation_position"),
                   "lineup_id": p.get("id"), "jersey_number": p.get("jersey_number")}
            used = set(row)
            for m in metrics(p):
                long_row = {"fixture_id": fid, "player_id": p["player_id"], "team_id": p["team_id"],
                            "source": m["source"], "type_id": m["type_id"], "name": m["name"]}
                long_row.update(scalar_fields(m["value"], "value"))
                tables["player_metrics"].append(long_row)
                # Keep the two feeds distinct, even when both supply expected goals.
                prefix = "xg_" if m["source"] == "xg" else ""
                name = prefix + m["name"].lower()
                values = scalar_fields(m["value"], name)
                for field, value in values.items():
                    if field in used:
                        raise ValueError(f"Duplicate player metric column: {fid}/{p['player_id']}/{field}")
                    used.add(field)
                    row[field] = value
            tables["player_match_stats"].append(row)
        for source in ("statistics", "xgfixture"):
            for m in f.get(source) or []:
                t = m.get("type") or {}
                row = {"fixture_id": fid, "team_id": m.get("participant_id"), "source": source,
                       "type_id": m.get("type_id"), "name": t.get("developer_name") or t.get("name")}
                row.update(scalar_fields((m.get("data") or {}).get("value"), "value"))
                tables["team_metrics"].append(row)
        for event in f.get("events") or []:
            row = scalar_fields(event)
            row.update(fixture_id=fid, event_id=event.get("id"), team_id=event.get("participant_id"))
            tables["events"].append(row)
        # Optional fixture relationships get their own tables rather than nested cells.
        for relation, values in f.items():
            if relation in {"lineups", "events", "statistics", "xgfixture"} or not isinstance(values, list):
                continue
            for index, value in enumerate(values):
                row = scalar_fields(value)
                row.update(fixture_id=fid, relation_index=index)
                tables[f"fixture_{relation}"].append(row)
    for name, data in resources.items():
        if name in {"teams", "topscorers"}:
            tables[name].extend(scalar_fields(row) for row in data)
        if name == "standings":
            tables[name].extend(standing_record(row) for row in data)
        if name.startswith("standings-round-"):
            for row in data:
                tables["round_standings"].append({**standing_record(row), "snapshot_round_id": name.removeprefix("standings-round-")})
        if name.startswith("squad-"):
            for squad in data:
                if squad.get("player"):
                    players[squad["player"]["id"]] = squad["player"]
                tables["squads"].append(scalar_fields({k:v for k,v in squad.items() if k != "player"}))
                for m in squad.get("details") or []:
                    row = {"season_id": squad["season_id"], "team_id": squad["team_id"], "player_id": squad["player_id"],
                           "type_id": m.get("type_id"), "name": (m.get("type") or {}).get("developer_name")}
                    row.update(scalar_fields(m.get("value"), "value"))
                    tables["player_season_metrics"].append(row)
        if name.startswith("current-squad-"):
            # Written only when downloaded, so an older export never reads as
            # "everyone left". Readers also require every league team to appear.
            team_id = name.removeprefix("current-squad-")
            for squad in data or []:
                tables["current_squads"].append(scalar_fields({**squad, "team_id": squad.get("team_id") or team_id}))
        if name.startswith("team-statistics-"):
            for statistic in data.get("statistics") or []:
                for m in statistic.get("details") or []:
                    row = {"season_id": statistic.get("season_id"), "team_id": data["id"],
                           "type_id": m.get("type_id"), "name": (m.get("type") or {}).get("developer_name")}
                    row.update(scalar_fields(m.get("value"), "value"))
                    tables["team_season_metrics"].append(row)
        if name.startswith("team-availability-"):
            for relation in ("sidelined", "coaches"):
                for value in data.get(relation) or []:
                    tables[f"team_{relation}"].append({**scalar_fields(value), "team_id": data["id"]})
    tables["players"] = [scalar_fields(p) for p in players.values()]
    counts = {}
    for name in sorted(set(tables) | set(headers)):
        write_table(folder / f"{name}.csv", tables[name], headers.get(name))
        counts[name] = len(tables[name])
    write_table(folder / "file_inventory.csv", [{"file": f"{name}.csv", "rows": count} for name,count in counts.items()], ["file", "rows"])
    return counts
