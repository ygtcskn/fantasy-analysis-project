import tempfile
from pathlib import Path
import unittest
from src.fetch.download_season import schedule_fixtures, merge_fixture
from src.fetch.export_csv import export_tables
from src.fetch.csv_store import read_table


class SeasonTests(unittest.TestCase):
    def test_schedule_finds_nested_and_deduplicates(self):
        fixture={"id":1,"season_id":2,"state_id":5,"starting_at_timestamp":100}
        self.assertEqual(schedule_fixtures([{"rounds":[{"fixtures":[fixture,fixture]}]}]),{1:fixture})

    def test_merging_xg_retains_player_statistics(self):
        old={"id":1,"lineups":[{"id":2,"player_id":3,"details":[{"data":{"value":0}}]}]}
        merge_fixture(old,{"id":1,"lineups":[{"id":2,"player_id":3,"xglineup":[{"data":{"value":0.5}}]}]})
        self.assertEqual(old['lineups'][0]['details'][0]['data']['value'],0)
        self.assertEqual(old['lineups'][0]['xglineup'][0]['data']['value'],0.5)

    def test_csv_export_retains_source_and_null_and_replaces_rows(self):
        fixture={"id":1,"season_id":2,"state_id":5,"lineups":[{"id":2,"player_id":3,"team_id":4,"type_id":11,
            "details":[{"type_id":7,"data":{"value":0},"type":{"developer_name":"SHOTS_TOTAL"}},
                       {"type_id":8,"data":{"value":None},"type":{"developer_name":"ASSISTS"}}],
            "xglineup":[{"type_id":5304,"data":{"value":0.25},"type":{"developer_name":"EXPECTED_GOALS"}}]}]}
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            for _ in range(2):
                counts=export_tables(folder,{1:fixture},{})
                self.assertEqual(counts['player_match_stats'],1)
            row=read_table(folder/'player_match_stats.csv')[0]
            self.assertEqual((row['shots_total'],row['assists'],row['xg_expected_goals']),('0','','0.25'))
            self.assertEqual(len(read_table(folder/'player_metrics.csv')),3)
            self.assertTrue(all(p.suffix=='.csv' for p in folder.iterdir()))

    def test_nested_season_values_are_columns(self):
        resource={'squad-4':[{'season_id':2,'team_id':4,'player_id':3,
                             'details':[{'type_id':7,'type':{'developer_name':'GOALS'},'value':{'total':2,'home':1}}]}]}
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            export_tables(folder,{},resource)
            row=read_table(folder/'player_season_metrics.csv')[0]
            self.assertEqual(row['value.total'],'2')
            self.assertEqual(row['value.home'],'1')


if __name__=='__main__': unittest.main()
