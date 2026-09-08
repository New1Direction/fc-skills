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

    def test_costs_change_comparison(self):
        out={p["id"]:p for p in analyze(self.d)["policies"]}
        self.assertEqual(f(out["wide"]["net_pnl"]),40)
        self.assertEqual(f(out["ladder"]["net_pnl"]),30)
        self.assertEqual(f(out["ladder"]["excess_vs_hold"]),-30)
    def test_lookahead_rejected(self):
        self.d["policies"][0]["available_at"]=101
        with self.assertRaises(ValueError): analyze(self.d)
    def test_unequal_capital_rejected(self):
        self.d["policies"][0]["capital"]="1001"
        with self.assertRaises(ValueError): analyze(self.d)
    def test_unknown_costs_not_ranked(self):
        self.d["policies"][0]["costs"]=None
        out=analyze(self.d)
        self.assertEqual(out["status"],"insufficient-evidence")
        self.assertIsNone(next(p for p in out["policies"] if p["id"]=="wide")["net_pnl"])
    def test_mixed_models_rejected(self):
        self.d["policies"][0]["model"]="stateful"
        with self.assertRaises(ValueError): analyze(self.d)

if __name__=="__main__": unittest.main()
