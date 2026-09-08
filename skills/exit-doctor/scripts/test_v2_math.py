import random
import unittest
from fractions import Fraction

from v2_math import UINT112_MAX, UINT256_MAX, amount_out, apply_sell, impact, remove_liquidity


class V2MathTests(unittest.TestCase):
    def test_known_example(self):
        self.assertEqual(amount_out(1000, 10000, 20000), 1813)

    def test_floor_against_fraction_property(self):
        rng = random.Random(8271)
        for _ in range(300):
            ri, ro = rng.randrange(10**8, 10**30), rng.randrange(10**8, 10**30)
            a = rng.randrange(1, 10**29)
            rational = Fraction(a, 1) * Fraction(997, 1000) * ro / (ri + Fraction(a * 997, 1000))
            out = amount_out(a, ri, ro)
            self.assertLessEqual(Fraction(out), rational)
            self.assertLess(rational, out + 1)
            self.assertLess(out, ro)

    def test_monotonic_and_fee_retained(self):
        ri, ro = 10**25, 10**22
        previous = -1
        for a in [1, 10**5, 10**18, 10**21, 10**24]:
            out = amount_out(a, ri, ro)
            self.assertGreaterEqual(out, previous)
            previous = out
            if out:
                output, ni, no = apply_sell(a, ri, ro)
                self.assertEqual(ni, ri + a)
                self.assertEqual(no, ro - output)
                self.assertGreaterEqual(ni * no, ri * ro)

    def test_high_precision(self):
        ri, ro, a = 2**103 + 187, 2**101 + 31, 2**80 + 7
        self.assertEqual(amount_out(a, ri, ro), (a * 997 * ro) // (1000 * ri + 997 * a))

    def test_reject_invalid_numbers(self):
        for a, ri, ro in [(True, 1, 2), (1, False, 2), (1, 2, 3.0), (0, 2, 3), (-1, 2, 3), (1, 0, 3), (1, 2, 0), (1, UINT112_MAX + 1, 3)]:
            with self.subTest(values=(a, ri, ro)), self.assertRaises(ValueError):
                amount_out(a, ri, ro)

    def test_uint256_intermediate_overflow(self):
        for a, ro in [(UINT256_MAX, 1), (UINT256_MAX // 997, UINT112_MAX)]:
            with self.assertRaisesRegex(ValueError, "overflow"):
                amount_out(a, 1, ro)

    def test_post_swap_uint112_overflow(self):
        self.assertGreater(amount_out(1000, UINT112_MAX, UINT112_MAX), 0)
        with self.assertRaises(ValueError):
            apply_sell(1000, UINT112_MAX, UINT112_MAX)

    def test_zero_output_is_quote_but_not_pair_swap(self):
        self.assertEqual(amount_out(1, 10000, 1), 0)
        with self.assertRaisesRegex(ValueError, "rounds to zero"):
            apply_sell(1, 10000, 1)

    def test_separate_impact_metrics(self):
        row = impact(1000, 10000, 20000)
        self.assertEqual(row["fee_adjusted_price_impact"], 1 - Fraction(1813, 1994))
        self.assertEqual(row["gross_spot_execution_shortfall"], 1 - Fraction(1813, 2000))
        self.assertLess(row["fee_adjusted_price_impact"], row["gross_spot_execution_shortfall"])

    def test_remove_both_sides_and_floor(self):
        self.assertEqual(remove_liquidity(10001, 20003, 2500), (7500, 15002))
        for bps in [-1, 10000, True]:
            with self.assertRaises(ValueError):
                remove_liquidity(10000, 20000, bps)


if __name__ == "__main__":
    unittest.main()
