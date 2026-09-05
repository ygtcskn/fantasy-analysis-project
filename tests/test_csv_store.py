import tempfile
from pathlib import Path
import unittest
from src.fetch.csv_store import write_table, read_table, write_tree, read_tree, scalar_fields


class CsvStoreTests(unittest.TestCase):
    def test_nested_roundtrip_preserves_types_and_text(self):
        value={"Turkish":"Beşiktaş, İstanbul\nYeni satır", "null":None,"empty":"","zero":0,
               "bool":False,"float":0.3057,"list":[None,{},[],{"slash/key":"~value"}]}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'cache.csv'
            write_tree(path,value)
            self.assertEqual(read_tree(path),value)
            self.assertTrue(all(p.suffix=='.csv' for p in Path(directory).iterdir()))

    def test_scalar_table_preserves_zero_and_csv_quoting(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'table.csv'
            write_table(path,[{'name':'A, "B"','goals':0,'assists':None}])
            self.assertEqual(read_table(path),[{'assists':'','goals':'0','name':'A, "B"'}])

    def test_nested_cells_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                write_table(Path(directory)/'table.csv',[{'value':{'nested':1}}])

    def test_scalars_flatten_to_columns(self):
        self.assertEqual(scalar_fields({'value':{'total':2,'home':0},'details':[]}),{'value.total':2,'value.home':0})


if __name__=='__main__': unittest.main()
