import unittest
from unittest.mock import Mock

from src.fetch import sportmonks as sm


class SportmonksTests(unittest.TestCase):
    def test_pagination_does_not_follow_provider_urls(self):
        client = sm.Client("test")
        client.get = Mock(side_effect=[{"data": [{"id": 1}], "pagination": {"has_more": True, "next_page": "https://untrusted.invalid"}}, {"data": [{"id": 2}], "pagination": {"has_more": False}}])
        self.assertEqual(client.all("leagues"), [{"id": 1}, {"id": 2}])
        self.assertEqual(client.get.call_args.kwargs["page"], 2)

    def test_null_and_zero_remain_distinct(self):
        records = sm.metrics({"details": [{"type_id": 1, "type": {"developer_name": "SHOTS"}, "data": {"value": 0}}, {"type_id": 2, "data": {"value": None}}], "xglineup": [{"type_id": 3, "type": {"name": "Expected Goals"}, "value": 0.2}]})
        self.assertEqual([r["value"] for r in records], [0, None, 0.2])
        self.assertEqual(records[1]["name"], "type_2")

    def test_live_xg_shape_uses_nested_value(self):
        row = {"xglineup": [{"type_id": 5304, "data": {"value": 0.3057}, "type": {"developer_name": "EXPECTED_GOALS"}}]}
        self.assertEqual(sm.metrics(row)[0]["value"], 0.3057)


if __name__ == "__main__":
    unittest.main()
