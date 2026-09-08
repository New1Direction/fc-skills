#!/usr/bin/env python3
"""Bounded, read-only Robinhood V4 evidence collection and deterministic replay.

Original Python implementation; no transaction construction or submission.
See references/v4-evidence.md for trust boundaries and supported semantics.
"""
import argparse
import copy
from decimal import Decimal, localcontext
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CHAIN_ID = 4663
MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
ZERO = "0x" + "00" * 20
MIN_SQRT = 4295128739
MAX_SQRT = 1461446703485210103287273052203988822378723970342
MASK = (1 << 64) - 1
# Keccak-f[1600] public algorithm round constants and rotation offsets.
RC = (0x1,0x8082,0x800000000000808a,0x8000000080008000,0x808b,0x80000001,
      0x8000000080008081,0x8000000000008009,0x8a,0x88,0x80008009,0x8000000a,
      0x8000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,
      0x8000000000008002,0x8000000000000080,0x800a,0x800000008000000a,
      0x8000000080008081,0x8000000000008080,0x80000001,0x8000000080008008)
ROT = ((0,36,3,41,18),(1,44,10,45,2),(62,6,43,15,61),
       (28,55,25,21,56),(27,20,39,8,14))

class EvidenceError(ValueError):
    pass

def require(ok, message):
    if not ok:
        raise EvidenceError(message)

def keccak256(data):
    """Ethereum Keccak-256, original permutation implementation (not SHA3-256)."""
    padded = bytearray(data)
    pad = 136 - len(padded) % 136
    padded.extend(b"\x01" + b"\x00" * (pad - 1))
    padded[-1] |= 0x80
    a = [0] * 25
    def rol(v, n):
        return ((v << n) | (v >> ((64 - n) % 64))) & MASK
    for off in range(0, len(padded), 136):
        for i in range(17):
            a[i] ^= int.from_bytes(padded[off + i*8:off + i*8 + 8], "little")
        for rc in RC:
            c = [a[x] ^ a[x+5] ^ a[x+10] ^ a[x+15] ^ a[x+20] for x in range(5)]
            d = [c[(x-1)%5] ^ rol(c[(x+1)%5], 1) for x in range(5)]
            for x in range(5):
                for y in range(5):
                    a[x+5*y] ^= d[x]
            b = [0] * 25
            for x in range(5):
                for y in range(5):
                    b[y + 5*((2*x+3*y)%5)] = rol(a[x+5*y], ROT[x][y])
            for x in range(5):
                for y in range(5):
                    a[x+5*y] = b[x+5*y] ^ ((~b[(x+1)%5+5*y]) & b[(x+2)%5+5*y])
            a[0] ^= rc
    return b"".join(v.to_bytes(8, "little") for v in a)[:32]

SWAP_TOPIC = "0x" + keccak256(b"Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)").hex()
INIT_TOPIC = "0x" + keccak256(b"Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)").hex()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)

def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()

def integer(value, name, low=0, high=(1 << 64)-1):
    require(type(value) is int and low <= value <= high, "invalid " + name)
    return value

def hx(value, size, name):
    require(type(value) is str and re.fullmatch("0x[0-9a-fA-F]{%d}" % (size*2), value) is not None,
            "invalid " + name)
    return value.lower()

def quantity(value, name):
    require(type(value) is str and re.fullmatch(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)", value) is not None,
            "invalid RPC quantity " + name)
    return int(value, 16)

def word(value):
    return (value % (1 << 256)).to_bytes(32, "big")

def words(data, count):
    raw = bytes.fromhex(hx(data, 32*count, "ABI data")[2:])
    return [int.from_bytes(raw[i:i+32], "big") for i in range(0, len(raw), 32)]

def uint(value, bits):
    require(0 <= value < 1 << bits, "noncanonical uint" + str(bits))
    return value

def sint(value, bits):
    result = value - (1 << 256) if value >= 1 << 255 else value
    require(-(1 << (bits-1)) <= result < 1 << (bits-1), "noncanonical int" + str(bits))
    return result

def address_word(value):
    return "0x" + uint(value, 160).to_bytes(20, "big").hex()

def source(value, name):
    require(type(value) is str and 3 <= len(value) <= 2000, "missing " + name)

def pool_id(pool):
    encoded = b"".join(word(x) for x in (int(pool["currency0"],16),int(pool["currency1"],16),
                       pool["fee"],pool["tick_spacing"],int(pool["hooks"],16)))
    return "0x" + keccak256(encoded).hex()

def valid_hook_address(hooks, fee):
    """Protocol key validity only; this does not qualify hook implementation behavior."""
    bits = int(hx(hooks,20,"hooks"),16)
    dynamic = fee == 0x800000
    # A return-delta permission requires its corresponding action permission.
    required_action = {3:7, 2:6, 1:10, 0:8}
    for delta_bit, action_bit in required_action.items():
        if bits & (1 << delta_bit) and not bits & (1 << action_bit):
            return False
    if bits == 0:
        return not dynamic
    return bool(bits & ((1 << 14)-1)) or dynamic

def validate_request(request):
    require(type(request) is dict, "request must be an object")
    require(request.get("schema") == "undertow.v4-request.v1", "request schema")
    integer(request.get("chain_id"), "chain_id", CHAIN_ID, CHAIN_ID)
    manager = request.get("manager", {})
    require(hx(manager.get("address"),20,"manager") == MANAGER, "unsupported manager")
    require(type(manager.get("expected_code_sha256")) is str and
            re.fullmatch("[0-9a-f]{64}", manager["expected_code_sha256"]), "manager code fingerprint required")
    source(manager.get("deployment_source"), "deployment source")
    source(manager.get("code_source"), "independent bytecode source")
    lo = integer(request.get("from_block"), "from_block")
    hi = integer(request.get("to_block"), "to_block", lo)
    require(hi-lo+1 <= 200, "maximum 200 blocks per evidence bundle")
    pools = request.get("pools")
    require(type(pools) is list and 1 <= len(pools) <= 20, "one to twenty pools required")
    seen = set()
    for p in pools:
        for name in ("currency0", "currency1", "base_currency", "hooks"):
            hx(p.get(name),20,name)
        require(int(p["currency0"],16) < int(p["currency1"],16), "currency order")
        require(p["base_currency"].lower() in (p["currency0"].lower(),p["currency1"].lower()), "base currency")
        integer(p.get("decimals0"), "decimals0",0,36)
        integer(p.get("decimals1"), "decimals1",0,36)
        integer(p.get("fee"),"fee",0,(1 << 24)-1)
        require(p["fee"] <= 1000000 or p["fee"] == 0x800000, "invalid pool fee")
        require(valid_hook_address(p["hooks"],p["fee"]), "invalid hook address/fee flags")
        integer(p.get("tick_spacing"),"tick_spacing",1,32767)
        pid = hx(p.get("pool_id"),32,"pool_id")
        require(pid == pool_id(p), "pool key hash mismatch")
        require(pid not in seen, "duplicate pool")
        seen.add(pid)
        hx(p.get("initialize_transaction"),32,"initialize transaction")
        integer(p.get("initialize_log_index"),"initialize log index")
    return request

def normalize_log(log):
    require(type(log) is dict, "log object required")
    require(log.get("removed") is False, "removed or unqualified log")
    topics = log.get("topics")
    require(type(topics) is list and len(topics) <= 4, "topics")
    result = {"address":hx(log.get("address"),20,"log address"),
              "block_hash":hx(log.get("blockHash"),32,"log block hash"),
              "transaction_hash":hx(log.get("transactionHash"),32,"transaction hash"),
              "block_number":quantity(log.get("blockNumber"),"block number"),
              "transaction_index":quantity(log.get("transactionIndex"),"transaction index"),
              "log_index":quantity(log.get("logIndex"),"log index"),
              "topics":[hx(t,32,"topic") for t in topics]}
    data = log.get("data")
    require(type(data) is str and re.fullmatch(r"0x(?:[0-9a-fA-F]{2})*",data) is not None, "log data")
    result["data"] = data.lower()
    return result

def decode_initialize(log, pool):
    n = normalize_log(log)
    require(n["address"] == MANAGER, "Initialize manager")
    require(n["topics"] == [INIT_TOPIC,pool["pool_id"].lower(),
            "0x"+word(int(pool["currency0"],16)).hex(),"0x"+word(int(pool["currency1"],16)).hex()], "Initialize topics")
    w = words(n["data"],5)
    fee, spacing, hooks, sqrt, tick = uint(w[0],24), sint(w[1],24), address_word(w[2]), uint(w[3],160), sint(w[4],24)
    require((fee,spacing,hooks) == (pool["fee"],pool["tick_spacing"],pool["hooks"].lower()), "Initialize pool key mismatch")
    require(MIN_SQRT <= sqrt < MAX_SQRT and -887272 <= tick <= 887272,"Initialize price range")
    require(n["transaction_hash"] == pool["initialize_transaction"].lower() and
            n["log_index"] == pool["initialize_log_index"], "Initialize identity")
    return n

def decode_swap(log, pool):
    n = normalize_log(log)
    require(n["address"] == MANAGER,"Swap manager")
    require(len(n["topics"]) == 3 and n["topics"][:2] == [SWAP_TOPIC,pool["pool_id"].lower()], "Swap topics")
    sender = address_word(int(n["topics"][2],16))
    w = words(n["data"],6)
    a0,a1,sqrt,liquidity,tick,fee = sint(w[0],128),sint(w[1],128),uint(w[2],160),uint(w[3],128),sint(w[4],24),uint(w[5],24)
    require(MIN_SQRT <= sqrt < MAX_SQRT and -887272 <= tick <= 887272,"Swap price range")
    require(fee <= 1000000,"Swap fee range")
    base0 = pool["base_currency"].lower() == pool["currency0"].lower()
    base_delta,quote_delta = (a0,a1) if base0 else (a1,a0)
    direction = "BUY_BASE" if base_delta > 0 and quote_delta < 0 else "SELL_BASE" if base_delta < 0 and quote_delta > 0 else "NONSTANDARD_OR_ZERO"
    with localcontext() as ctx:
        ctx.prec = 90
        ratio = Decimal(sqrt)**2 / Decimal(2)**192 * Decimal(10)**(pool["decimals0"]-pool["decimals1"])
        mark = ratio if base0 else 1/ratio
    hooks = pool["hooks"].lower()
    return {"chain_id":CHAIN_ID,"manager":MANAGER,"pool_id":pool["pool_id"].lower(),
            **{k:n[k] for k in ("block_hash","block_number","transaction_hash","transaction_index","log_index")},
            "sender":sender,"sender_role":"IMMEDIATE_CALLER_NOT_TRADER","trader":None,
            "amount0_raw":str(a0),"amount1_raw":str(a1),"core_direction":direction,
            "base_currency":pool["base_currency"].lower(),
            "quote_currency":pool["currency1" if base0 else "currency0"].lower(),
            "sqrt_price_x96":str(sqrt),"active_liquidity_raw":str(liquidity),"tick":tick,"fee_pips":fee,
            "quote_per_base_mark":str(mark),"price_kind":"CORE_POST_SWAP_SPOT_MARK",
            "hooks":hooks,"hook_status":"NO_HOOK" if hooks == ZERO else "UNKNOWN_HOOK_UNQUALIFIED",
            "wallet_cash_flow":None,"executable_proceeds":None,"pool_inventory":None,
            "evidence_sha256":digest(n)}

def _run(request, rpc):
    validate_request(request)
    require(quantity(rpc("eth_chainId",[]),"chain id") == CHAIN_ID,"wrong RPC chain")
    lo,hi = request["from_block"],request["to_block"]
    headers = {}
    receipts = {}
    def header(number):
        if number not in headers:
            value = rpc("eth_getBlockByNumber",[hex(number),False])
            require(type(value) is dict and quantity(value.get("number"),"header number") == number,"missing/wrong block")
            headers[number] = {"number":number,"hash":hx(value.get("hash"),32,"header hash"),
                               "parent_hash":hx(value.get("parentHash"),32,"parent hash"),
                               "timestamp":quantity(value.get("timestamp"),"timestamp")}
        return headers[number]
    for number in range(lo,hi+1):
        h = header(number)
        if number > lo:
            require(h["parent_hash"] == headers[number-1]["hash"],"noncontiguous headers")
            require(h["timestamp"] >= headers[number-1]["timestamp"],"decreasing timestamp")
    def receipt(tx):
        tx = tx.lower()
        if tx not in receipts:
            value = rpc("eth_getTransactionReceipt",[tx])
            require(type(value) is dict,"missing receipt")
            require(hx(value.get("transactionHash"),32,"receipt tx") == tx,"receipt transaction mismatch")
            require(quantity(value.get("status"),"receipt status") == 1,"failed receipt")
            number = quantity(value.get("blockNumber"),"receipt block")
            h = header(number)
            require(hx(value.get("blockHash"),32,"receipt block hash") == h["hash"],"receipt/header mismatch")
            index = quantity(value.get("transactionIndex"),"receipt transaction index")
            logs = value.get("logs")
            require(type(logs) is list and len(logs) <= 10000,"receipt log limit")
            keys = set()
            for log in logs:
                n = normalize_log(log)
                require((n["block_number"],n["block_hash"],n["transaction_hash"],n["transaction_index"]) ==
                        (number,h["hash"],tx,index),"receipt log context mismatch")
                require(n["log_index"] not in keys,"duplicate receipt log index")
                keys.add(n["log_index"])
            receipts[tx] = value
        return receipts[tx]
    def pin(number):
        return {"blockHash":header(number)["hash"],"requireCanonical":True}
    # Both endpoint codes must match an independently supplied deployed-runtime fingerprint.
    for number in sorted({lo,hi}):
        code = rpc("eth_getCode",[MANAGER,pin(number)])
        require(type(code) is str and re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+",code) is not None,"empty/invalid manager code")
        require(hashlib.sha256(bytes.fromhex(code[2:])).hexdigest() == request["manager"]["expected_code_sha256"],"manager runtime code mismatch")
    decimals = {}
    init_by_pool = {}
    for pool in request["pools"]:
        init_receipt = receipt(pool["initialize_transaction"])
        choices = [log for log in init_receipt["logs"] if quantity(log["logIndex"],"init log index") == pool["initialize_log_index"]]
        require(len(choices) == 1,"missing Initialize")
        initial = decode_initialize(choices[0],pool)
        require(initial["block_number"] <= lo,"pool initialized after range start")
        init_by_pool[pool["pool_id"].lower()] = initial
        for index in (0,1):
            token = pool["currency"+str(index)].lower()
            declared = pool["decimals"+str(index)]
            require(token not in decimals or decimals[token] == declared,"conflicting token decimals")
            if token not in decimals:
                if token == ZERO:
                    require(declared == 18,"native ETH decimals")
                else:
                    for number in sorted({lo,hi}):
                        result = rpc("eth_call",[{"to":token,"data":"0x313ce567"},pin(number)])
                        actual = uint(words(result,1)[0],8)
                        require(actual == declared,"token decimals mismatch")
                decimals[token] = declared
    ids = sorted(p["pool_id"].lower() for p in request["pools"])
    by_pool = {p["pool_id"].lower():p for p in request["pools"]}
    raw_logs = []
    identities = set()
    for start in range(lo,hi+1,10):
        end = min(start+9,hi)
        logs = rpc("eth_getLogs",[{"address":MANAGER,"fromBlock":hex(start),"toBlock":hex(end),"topics":[SWAP_TOPIC,ids]}])
        require(type(logs) is list and len(raw_logs)+len(logs) <= 2000,"log collection limit exceeded")
        for log in logs:
            n = normalize_log(log)
            require(start <= n["block_number"] <= end,"out-of-shard log")
            require(n["block_hash"] == header(n["block_number"])["hash"],"log/header mismatch")
            require(n["address"] == MANAGER and len(n["topics"]) == 3 and n["topics"][0] == SWAP_TOPIC and n["topics"][1] in by_pool,"out-of-filter log")
            identity = (n["block_hash"],n["log_index"])
            require(identity not in identities,"duplicate returned log")
            identities.add(identity)
            initial = init_by_pool[n["topics"][1]]
            require((n["block_number"],n["transaction_index"],n["log_index"]) >
                    (initial["block_number"],initial["transaction_index"],initial["log_index"]),"Swap precedes Initialize")
            r = receipt(n["transaction_hash"])
            require(any(canonical(normalize_log(x)) == canonical(n) for x in r["logs"]),"log absent from receipt")
            raw_logs.append(log)
    # Catch omitted queried logs that are visible in receipts already retrieved.
    for r in receipts.values():
        for log in r["logs"]:
            n = normalize_log(log)
            if lo <= n["block_number"] <= hi and n["address"] == MANAGER and len(n["topics"]) >= 2 and n["topics"][0] == SWAP_TOPIC and n["topics"][1] in by_pool:
                require((n["block_hash"],n["log_index"]) in identities,"query omitted a swap visible in receipt")
    rows = []
    for log in sorted(raw_logs,key=lambda x:(quantity(x["blockNumber"],"block"),quantity(x["transactionIndex"],"tx"),quantity(x["logIndex"],"log"))):
        row = decode_swap(log,by_pool[log["topics"][1].lower()])
        row["block_timestamp"] = header(row["block_number"])["timestamp"]
        rows.append(row)
    # Re-read all observation and initialization block identities, never silently repin.
    for number,h in sorted(headers.items()):
        final = rpc("eth_getBlockByNumber",[hex(number),False])
        require(type(final) is dict and quantity(final.get("number"),"recheck number") == number and
                hx(final.get("hash"),32,"recheck hash") == h["hash"] and
                hx(final.get("parentHash"),32,"recheck parent") == h["parent_hash"] and
                quantity(final.get("timestamp"),"recheck timestamp") == h["timestamp"],"block changed during collection")
    return {"schema":"undertow.v4-evidence-report.v1","status":"PROVIDER_CONSISTENT",
            "chain_id":CHAIN_ID,"manager":MANAGER,"from_block":lo,"to_block":hi,
            "request_sha256":digest(request),"blocks":[headers[n] for n in sorted(headers)],
            "pool_initializations":init_by_pool,"swaps":rows,
            "coverage":{"requested_blocks":hi-lo+1,"returned_swaps":len(rows),
                        "scope":"configured pool IDs and Swap topic only","provider_reports_all_shards":True,
                        "independently_complete":False,"finality":"NOT_PROVEN"},
            "limitations":["RPC transcript consistency is not a cryptographic chain proof.",
                "Empty RPC logs do not independently prove absence; no market-wide discovery.",
                "State reads use EIP-1898 block hashes; block rechecks do not prove L1 finality.",
                "Decimals checked at endpoints; standard stable token metadata assumed between them.",
                "Core deltas precede afterSwap hook adjustments and are not wallet cash flows.",
                "Nonzero hooks are unqualified; no hook-specific interpretation is implemented.",
                "Sender is immediate caller; trader attribution requires separate evidence.",
                "Core spot mark is neither a quote nor executable value; singleton balances are not pool inventory."]}

class Recorder:
    def __init__(self,rpc):
        self.rpc,self.entries = rpc,[]
    def __call__(self,method,params):
        require(len(self.entries)<2500,"RPC call limit")
        entry = {"method":method,"params":copy.deepcopy(params)}
        self.entries.append(entry)
        try:
            result = self.rpc(method,params)
            entry["result"] = copy.deepcopy(result)
            return result
        except Exception as error:
            entry["error_type"] = type(error).__name__
            raise

def collect(request,rpc):
    recorder = Recorder(rpc)
    report = _run(copy.deepcopy(request),recorder)
    return {"schema":"undertow.v4-bundle.v1","request":copy.deepcopy(request),
            "rpc_transcript":recorder.entries,"report":report,
            "transcript_sha256":digest(recorder.entries)}

def verify(bundle,expected_request):
    require(type(bundle) is dict and bundle.get("schema") == "undertow.v4-bundle.v1","bundle schema")
    validate_request(expected_request)
    require(canonical(bundle.get("request")) == canonical(expected_request),"request differs from independent manifest")
    entries = bundle.get("rpc_transcript")
    require(type(entries) is list and 1 <= len(entries) <= 2500,"transcript length")
    require(digest(entries) == bundle.get("transcript_sha256"),"transcript digest mismatch")
    cursor = 0
    def replay(method,params):
        nonlocal cursor
        require(cursor < len(entries),"truncated transcript")
        entry = entries[cursor]
        cursor += 1
        require(type(entry) is dict and set(entry) == {"method","params","result"},"incomplete transcript entry")
        require(entry["method"] == method and canonical(entry["params"]) == canonical(params),"transcript call mismatch")
        return copy.deepcopy(entry["result"])
    report = _run(copy.deepcopy(expected_request),replay)
    require(cursor == len(entries),"unconsumed transcript entries")
    require(canonical(report) == canonical(bundle.get("report")),"normalized report mismatch")
    return report

class HTTPRPC:
    def __init__(self,url,timeout=10,wall_seconds=180):
        parts=urllib.parse.urlsplit(url)
        require(parts.scheme == "https" and parts.hostname and not parts.username and not parts.password,"HTTPS RPC URL required")
        self.url,self.timeout,self.deadline,self.counter=url,timeout,time.monotonic()+wall_seconds,0
    def __call__(self,method,params):
        remaining=self.deadline-time.monotonic()
        require(remaining>0,"RPC wall time limit")
        require(method in {"eth_chainId","eth_getBlockByNumber","eth_getCode","eth_call","eth_getLogs","eth_getTransactionReceipt"},"read-only RPC method restriction")
        self.counter+=1
        payload={"jsonrpc":"2.0","id":self.counter,"method":method,"params":params}
        request=urllib.request.Request(self.url,data=canonical(payload).encode(),headers={"Content-Type":"application/json"})
        try:
            with urllib.request.urlopen(request,timeout=min(self.timeout,remaining)) as response:
                raw=response.read(8*1024*1024+1)
                require(len(raw)<=8*1024*1024,"RPC response size limit")
            result=json.loads(raw)
        except (urllib.error.URLError,TimeoutError,OSError,json.JSONDecodeError) as error:
            # Do not include endpoint URLs or provider response bodies that may expose API keys.
            raise EvidenceError("RPC transport failure: " + type(error).__name__) from None
        require(type(result) is dict and result.get("jsonrpc") == "2.0" and type(result.get("id")) is int and result["id"] == self.counter,"RPC response envelope")
        require("error" not in result and "result" in result,"RPC returned error or no result")
        return result["result"]

def read_json(path):
    require(Path(path).stat().st_size <= 64*1024*1024,"input file too large")
    return json.loads(Path(path).read_text())

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest="command",required=True)
    c=sub.add_parser("collect")
    c.add_argument("--request",required=True);c.add_argument("--rpc-env",default="RH_RPC_URL");c.add_argument("--out",required=True)
    v=sub.add_parser("verify")
    v.add_argument("--request",required=True,help="Independent trusted request manifest, not extracted from untrusted bundle")
    v.add_argument("--bundle",required=True);v.add_argument("--out",required=True)
    args=parser.parse_args()
    try:
        request=read_json(args.request)
        validate_request(request)
        if args.command=="collect":
            endpoint=os.environ.get(args.rpc_env)
            require(endpoint is not None,"RPC environment variable missing")
            recorder=Recorder(HTTPRPC(endpoint))
            try:
                report=_run(copy.deepcopy(request),recorder)
            except Exception as error:
                Path(args.out).write_text(json.dumps({"schema":"undertow.v4-failed-collection.v1","status":"FAILED",
                  "request":request,"rpc_transcript":recorder.entries,"error_type":type(error).__name__,
                  "normalized_report":None},indent=2)+"\n")
                raise
            result={"schema":"undertow.v4-bundle.v1","request":request,"rpc_transcript":recorder.entries,
                    "report":report,"transcript_sha256":digest(recorder.entries)}
        else:
            result=verify(read_json(args.bundle),request)
        Path(args.out).write_text(json.dumps(result,indent=2,allow_nan=False)+"\n")
        print(json.dumps({"status":"OK","output":str(Path(args.out))}))
        return 0
    except (EvidenceError,KeyError,TypeError,ValueError,OSError) as error:
        print(json.dumps({"status":"FAILED","reason":str(error)}),file=sys.stderr)
        return 2

if __name__=="__main__":
    raise SystemExit(main())
