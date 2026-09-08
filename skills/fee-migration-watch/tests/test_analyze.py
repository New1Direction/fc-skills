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

    def test_shift_and_fee_decline(self):
        out=analyze(self.d)
        self.assertEqual(f(out["pools"][0]["volume_share_change"]), Fraction(-7,10))
        self.assertEqual(f(out["pools"][1]["volume_share_change"]), Fraction(7,10))
        self.assertEqual([f(x) for x in out["total_lp_fees"]],[28,14])
    def test_changed_cohort(self):
        self.d["windows"][1]["pools"][0]["id"]="new-pool"
        with self.assertRaises(ValueError): analyze(self.d)
    def test_missing_fee(self):
        self.d["windows"][0]["pools"][0]["lp_fees"]=None
        self.assertEqual(analyze(self.d)["status"],"insufficient-evidence")
    def test_no_prior_volume_not_infinite(self):
        for p in self.d["windows"][0]["pools"]: p["volume"]="0"
        self.assertIsNone(analyze(self.d)["pools"][0]["volume_share_change"])
    def test_overlap_rejected(self):
        self.d["windows"][1]["start"]=299
        with self.assertRaises(ValueError): analyze(self.d)

if __name__=="__main__": unittest.main()
