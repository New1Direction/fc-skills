"""Exact canonical Uniswap V2 (997/1000) arithmetic; no token transfer model.

amount_out matches the library's integer operations. apply_sell additionally
checks the pair's uint112 balance update and nonzero-output requirement.
"""
from fractions import Fraction

UINT256_MAX = (1 << 256) - 1
UINT112_MAX = (1 << 112) - 1


def integer(value, name, minimum=0, maximum=UINT256_MAX):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    return value


def mul(a, b):
    value = a * b
    if value > UINT256_MAX:
        raise ValueError("uint256 multiplication overflow")
    return value


def add(a, b):
    value = a + b
    if value > UINT256_MAX:
        raise ValueError("uint256 addition overflow")
    return value


def amount_out(amount_in: int, reserve_in: int, reserve_out: int) -> int:
    integer(amount_in, "amount_in", 1)
    integer(reserve_in, "reserve_in", 1, UINT112_MAX)
    integer(reserve_out, "reserve_out", 1, UINT112_MAX)
    adjusted = mul(amount_in, 997)
    numerator = mul(adjusted, reserve_out)
    denominator = add(mul(reserve_in, 1000), adjusted)
    return numerator // denominator


def apply_sell(amount_in: int, reserve_in: int, reserve_out: int):
    output = amount_out(amount_in, reserve_in, reserve_out)
    if output == 0:
        raise ValueError("swap output rounds to zero; pair cannot execute it")
    new_in = add(reserve_in, amount_in)
    integer(new_in, "post-swap reserve_in", 1, UINT112_MAX)
    return output, new_in, reserve_out - output


def impact(amount_in: int, reserve_in: int, reserve_out: int):
    """Both shortfalls include integer-output rounding; only gross includes fee."""
    output = amount_out(amount_in, reserve_in, reserve_out)
    spot = Fraction(amount_in * reserve_out, reserve_in)
    fee_adjusted = spot * Fraction(997, 1000)
    return {
        "amount_out": output,
        "fee_adjusted_price_impact": 1 - Fraction(output, 1) / fee_adjusted,
        "gross_spot_execution_shortfall": 1 - Fraction(output, 1) / spot,
    }


def remove_liquidity(reserve_in: int, reserve_out: int, removal_bps: int):
    integer(reserve_in, "reserve_in", 1, UINT112_MAX)
    integer(reserve_out, "reserve_out", 1, UINT112_MAX)
    integer(removal_bps, "removal_bps", 0, 9999)
    # Explicit proportional-reserve model, not an LP-token burn calculation.
    kept = 10000 - removal_bps
    rin, rout = reserve_in * kept // 10000, reserve_out * kept // 10000
    if rin == 0 or rout == 0:
        raise ValueError("liquidity removal leaves a zero reserve")
    return rin, rout
