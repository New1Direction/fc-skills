"""Deterministic retained-summary checks. No RPC, signing, or swap replay."""
import argparse
import json
import re
from fractions import Fraction
from pathlib import Path

def num(v, signed=False):
    if not isinstance(v, str) or not re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", v):
        raise ValueError("amounts must be finite decimal strings")
    x = Fraction(v)
    if not signed and x < 0:
        raise ValueError("negative amount")
    return x

def optional(v, signed=False):
    return None if v is None else num(v, signed)

def rat(x):
    return None if x is None else {"numerator": str(x.numerator), "denominator": str(x.denominator)}

def ratio(a, b):
    return None if a is None or b is None or b == 0 else a / b

def integer(x):
    if type(x) is not int or x < 0:
        raise ValueError("expected nonnegative integer")
    return x

def ident(x):
    if not isinstance(x, str) or not x.strip():
        raise ValueError("missing identity")
    return x

def flag(d, k):
    if type(d.get(k)) is not bool:
        raise ValueError(k + " must be a boolean")
    return d[k]

def unique(items, key):
    out = {}
    for item in items:
        k = ident(item[key])
        if k in out:
            raise ValueError("duplicate " + key)
        out[k] = item
    return out

def envelope(d):
    if d.get("schema") != "lp-research.v1":
        raise ValueError("unsupported schema")
    integer(d["chain_id"])
    pair = d["pair"]
    if not isinstance(pair, list) or len(pair) != 2 or len(set(pair)) != 2:
        raise ValueError("two distinct exact token identities required")
    for p in pair:
        ident(p)
    ident(d["denomination"])
    ident(d["evidence_kind"])
    if not isinstance(d["source_refs"], list) or not d["source_refs"]:
        raise ValueError("source_refs required")
    for s in d["source_refs"]:
        ident(s)
    flag(d, "coverage_complete")
    start, end = integer(d["period"]["start"]), integer(d["period"]["end"])
    if end <= start:
        raise ValueError("positive explicit observation period required")
    return {"schema": "lp-research-report.v1", "mode": d["mode"],
            "evidence_kind": d["evidence_kind"], "source_refs": d["source_refs"],
            "denomination": d["denomination"], "chain_id": d["chain_id"],
            "pair": d["pair"], "period": d["period"], "input_coverage_claim": d["coverage_complete"],
            "source_authenticity": "not-verified-by-helper", "execution": "none",
            "status": "summary-calculated" if d["coverage_complete"] else "insufficient-evidence"}

def windows(d):
    ws = d["windows"]
    if len(ws) != 2:
        raise ValueError("exactly prior and current windows required")
    for w in ws:
        integer(w["start"]); integer(w["end"])
        if w["end"] <= w["start"]:
            raise ValueError("empty window")
    duration = ws[0]["end"] - ws[0]["start"]
    if ws[0]["end"] != ws[1]["start"] or ws[1]["end"] - ws[1]["start"] != duration:
        raise ValueError("adjacent equal-duration windows required")
    if ws[0]["start"] != d["period"]["start"] or ws[1]["end"] != d["period"]["end"]:
        raise ValueError("windows must span report period")
    maps = [unique(w["pools"], "id") for w in ws]
    if not maps[0] or set(maps[0]) != set(maps[1]):
        raise ValueError("identical nonempty pool cohorts required; do not invent zero history")
    return maps, duration

def flow(d, out):
    maps, duration = windows(d)
    if d["mode"] == "lp-flow-decay" and len(maps[0]) != 1:
        raise ValueError("decay helper requires exactly one pool")
    totals = [sum((num(p["volume"]) for p in m.values()), Fraction()) for m in maps]
    fees = [[optional(p["lp_fees"]) for p in m.values()] for m in maps]
    out["total_lp_fees"] = [rat(None if None in f else sum(f, Fraction())) for f in fees]
    if any(None in f for f in fees):
        out["status"] = "insufficient-evidence"
    out["pools"] = []
    for k in sorted(maps[0]):
        a, b = maps[0][k], maps[1][k]
        va, vb = num(a["volume"]), num(b["volume"])
        fa, fb = optional(a["lp_fees"]), optional(b["lp_fees"])
        sa, sb = ratio(va, totals[0]), ratio(vb, totals[1])
        out["pools"].append({"id": k, "prior_volume_share": rat(sa), "current_volume_share": rat(sb),
            "volume_share_change": rat(None if sa is None or sb is None else sb-sa),
            "prior_volume_rate": rat(va/duration), "current_volume_rate": rat(vb/duration),
            "volume_rate_change_fraction": rat(ratio(vb-va,va)),
            "prior_lp_fee_rate": rat(None if fa is None else fa/duration),
            "current_lp_fee_rate": rat(None if fb is None else fb/duration),
            "lp_fee_rate_change_fraction": rat(None if fa is None or fb is None else ratio(fb-fa,fa))})
    out["interpretation_limit"] = "observed summaries only; no capital migration, forecast, position yield or exit trigger"

def wallet(d, out):
    complete = flag(d,"costs_complete") and flag(d,"positions_complete") and d["coverage_complete"]
    a = num(d["opening_equity"])
    b = optional(d["closing_equity"])
    c, w = num(d["contributions"]), num(d["withdrawals"])
    costs = optional(d["external_costs"])
    gross = None if b is None else b+w-c-a
    out["marked_pnl_before_external_costs"] = rat(gross)
    out["net_marked_pnl"] = rat(gross-costs) if complete and gross is not None and costs is not None else None
    if out["net_marked_pnl"] is None:
        out["status"] = "insufficient-evidence"
    episodes = unique(d.get("episodes", []),"id").values()
    closed = []
    opened = 0
    for e in episodes:
        if flag(e,"closed"):
            closed.append(optional(e["pnl"],signed=True))
        else:
            opened += 1
    out["open_episodes"] = opened
    out["closed_episodes"] = len(closed)
    out["closed_win_rate"] = rat(Fraction(sum(x>0 for x in closed),len(closed))) if closed and None not in closed and complete else None
    out["interpretation_limit"] = "marked account result; episode win rate is not total return; no live exit proof or fee attribution"

def replay(d, out):
    decision = integer(d["decision_time"])
    if decision != d["period"]["start"]:
        raise ValueError("decision must equal start of replay period")
    budget = num(d["budget"])
    if budget <= 0:
        raise ValueError("positive equal starting budget required")
    policies = unique(d["policies"],"id")
    if not policies:
        raise ValueError("policies required")
    models = set()
    out["policies"] = []
    complete = flag(d,"costs_complete") and d["coverage_complete"]
    for k,p in sorted(policies.items()):
        if integer(p["available_at"]) > decision:
            raise ValueError("policy uses inputs available after decision")
        if num(p["capital"]) != budget:
            raise ValueError("unequal total capital including idle assets")
        model = p["model"]
        if model not in ("scenario","marginal","stateful"):
            raise ValueError("unknown evidence model")
        models.add(model)
        terminal, cost, hold = optional(p["terminal_before_costs"]), optional(p["costs"]), optional(p["hold_terminal"])
        net = terminal-cost if complete and terminal is not None and cost is not None else None
        out["policies"].append({"id":k,"model":model,"terminal_after_costs":rat(net),
            "net_pnl":rat(None if net is None else net-budget),
            "excess_vs_hold":rat(None if net is None or hold is None else net-hold)})
        if net is None or hold is None:
            out["status"]="insufficient-evidence"
    if len(models) != 1:
        raise ValueError("different evidence models are not a fair ranked comparison")
    out["interpretation_limit"]="supplied summary audit only; no native swap replay, forward edge or ranking"

def quality(d, out):
    seen = {}; duplicates = 0
    for s in d["swaps"]:
        k=ident(s["id"])
        if k in seen:
            if seen[k] != s:
                raise ValueError("conflicting duplicate canonical swap")
            duplicates += 1
        else:
            seen[k]=s
    actors={}; total=Fraction(); known=Fraction(); fees=[]
    for s in seen.values():
        v=num(s["volume"]); total+=v
        fees.append(optional(s["lp_fee"]))
        if s["actor"] is not None:
            actor=ident(s["actor"]); known+=v
            actors[actor]=actors.get(actor,Fraction())+v
    out.update({"unique_swaps":len(seen),"duplicate_rows_removed":duplicates,
        "total_volume":rat(total),"attributed_volume_fraction":rat(ratio(known,total)),
        "largest_known_actor_share_of_all_volume":rat(ratio(max(actors.values(), default=Fraction()),total)),
        "hhi_conditional_on_known_volume":rat(sum((v/known)**2 for v in actors.values()) if known else None),
        "allocated_lp_fees":rat(None if None in fees else sum(fees,Fraction()))})
    if not seen or None in fees:
        out["status"]="insufficient-evidence"
    out["interpretation_limit"]="unknown actors are not independent wallets; concentration does not prove bots, wash trading or fee persistence"

def analyze(d, expected_mode=None):
    out=envelope(d)
    if expected_mode is not None and d["mode"] != expected_mode:
        raise ValueError("wrong skill mode")
    handlers={"fee-migration-watch":flow,"lp-flow-decay":flow,"lp-wallet-autopsy":wallet,
              "range-replay":replay,"fee-quality-check":quality}
    if d["mode"] not in handlers:
        raise ValueError("unknown mode")
    handlers[d["mode"]](d,out)
    return out

def main(expected_mode):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("input",type=Path)
    p.add_argument("--output",type=Path)
    a=p.parse_args()
    try:
        out=analyze(json.loads(a.input.read_text()),expected_mode)
        encoded=json.dumps(out,indent=2,sort_keys=True)+"\n"
    except (ValueError,KeyError,TypeError,ZeroDivisionError) as e:
        p.error(str(e))
    if a.output:
        a.output.write_text(encoded)
    else:
        print(encoded,end="")

if __name__ == "__main__":
    main("fee-migration-watch")
