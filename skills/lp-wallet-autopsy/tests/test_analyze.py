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

    def test_open_loser_and_external_funding(self):
        out=analyze(self.d)
        self.assertEqual(f(out["net_marked_pnl"]),-310)
        self.assertEqual(f(out["closed_win_rate"]),1)
        self.assertEqual(out["open_episodes"],1)
    def test_unknown_costs_not_zero(self):
        self.d["external_costs"]=None
        self.assertIsNone(analyze(self.d)["net_marked_pnl"])
    def test_unknown_positions(self):
        self.d["positions_complete"]=False
        self.assertIsNone(analyze(self.d)["net_marked_pnl"])
    def test_withdrawals_are_not_losses(self):
        self.d.update(closing_equity="0",contributions="0",withdrawals="1100",external_costs="0")
        self.assertEqual(f(analyze(self.d)["net_marked_pnl"]),100)
    def test_unknown_closed_episode(self):
        self.d["episodes"][0]["pnl"]=None
        self.assertIsNone(analyze(self.d)["closed_win_rate"])

if __name__=="__main__": unittest.main()
