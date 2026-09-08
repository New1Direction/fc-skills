import json
import sys
import unittest
from copy import deepcopy
from fractions import Fraction
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"scripts"))
from analyze import analyze,num

def f(x):
    return Fraction(int(x["numerator"]),int(x["denominator"]))

class Cases(unittest.TestCase):
    def setUp(self):
        self.d=json.loads((ROOT/"examples/synthetic.json").read_text())
    def test_incomplete_coverage(self):
        self.d["coverage_complete"]=False
        self.assertEqual(analyze(self.d)["status"],"insufficient-evidence")
    def test_float_rejected(self):
        with self.assertRaises(ValueError): num(0.1)
    def test_nonfinite_rejected(self):
        for v in ("NaN","Infinity","1e10"):
            with self.assertRaises(ValueError): num(v)
    def test_exact_large_amount(self):
        self.assertEqual(num("123456789012345678901234567890.125"),Fraction(987654312098765431209876543121,8))
    def test_missing_source(self):
        self.d["source_refs"]=[]
        with self.assertRaises(ValueError): analyze(self.d)
    def test_false_string_not_boolean(self):
        self.d["coverage_complete"]="false"
        with self.assertRaises(ValueError): analyze(self.d)

    def test_partial_attribution(self):
        out=analyze(self.d)
        self.assertEqual(f(out["attributed_volume_fraction"]),Fraction(9,10))
        self.assertEqual(f(out["hhi_conditional_on_known_volume"]),Fraction(65,81))
        self.assertEqual(f(out["largest_known_actor_share_of_all_volume"]),Fraction(4,5))
    def test_duplicate_removed(self):
        self.d["swaps"].append(deepcopy(self.d["swaps"][0]))
        out=analyze(self.d)
        self.assertEqual(out["duplicate_rows_removed"],1)
        self.assertEqual(f(out["total_volume"]),100)
    def test_conflicting_duplicate_rejected(self):
        s=deepcopy(self.d["swaps"][0]);s["volume"]="99";self.d["swaps"].append(s)
        with self.assertRaises(ValueError): analyze(self.d)
    def test_unknown_actors_not_single_cluster(self):
        for s in self.d["swaps"]: s["actor"]=None
        out=analyze(self.d)
        self.assertIsNone(out["hhi_conditional_on_known_volume"])
        self.assertEqual(f(out["attributed_volume_fraction"]),0)
    def test_unknown_fees(self):
        self.d["swaps"][0]["lp_fee"]=None
        self.assertIsNone(analyze(self.d)["allocated_lp_fees"])

if __name__=="__main__": unittest.main()
