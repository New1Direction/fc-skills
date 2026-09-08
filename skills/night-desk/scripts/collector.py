#!/usr/bin/env python3
"""Bounded Robinhood REST evidence capture, derived from MSK Undertow's pattern.

This implementation is self-contained; it retains partial failures and corporate actions.
"""
from datetime import datetime, timezone
import hashlib
import re
import urllib.request
import urllib.error

from night_desk import address, canonical, dec, strict_json, timestamp, analyze

BASE = "https://api.robinhood.com/rhj/"
BODY_LIMIT = 4_000_000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("unexpected endpoint redirect")


def fetch(url):
    allowed = url in (BASE + "assets", BASE + "corporate-actions") or re.fullmatch(re.escape(BASE) + r"prices/[A-Z0-9.-]{1,20}", url)
    if not allowed:
        raise ValueError("unsupported collector URL")
    started = datetime.now(timezone.utc).isoformat()
    request = urllib.request.Request(url, headers={"User-Agent": "MSK-NightDesk/1.0 read-only research", "Accept": "application/json"})
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=12)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(BODY_LIMIT + 1)
        oversized = len(body) > BODY_LIMIT
        body = body[:BODY_LIMIT]
        raw = body.decode("utf-8")
        return {"url": url, "http_status": response.status, "requested_at": started,
                "received_at": datetime.now(timezone.utc).isoformat(), "body_utf8": raw,
                "body_sha256": hashlib.sha256(body).hexdigest(), "truncated": oversized,
                "headers": {k.lower(): v for k, v in response.headers.items()
                            if k.lower() in ("date", "age", "cache-control", "etag", "retry-after")}}


def matching(rows, symbol, token):
    if not isinstance(rows, list):
        raise ValueError("expected API row array")
    found = []
    for row in rows:
        if not isinstance(row, dict) or row.get("tokenSymbol") != symbol:
            continue
        deployments = row.get("deployments")
        if not isinstance(deployments, list):
            raise ValueError("missing deployments for matching symbol")
        chain = [d for d in deployments if isinstance(d, dict) and type(d.get("chainId")) is int and d["chainId"] == 4663]
        if len(chain) == 1 and address(chain[0]["contractAddress"]) == token:
            found.append(row)
    if len(found) != 1:
        raise ValueError("expected exactly one symbol and exact chain-contract match")
    return found[0]


def response_data(record, url, previous_end=None):
    if record.get("url") != url or type(record.get("http_status")) is not int or record["http_status"] != 200:
        raise ValueError("reference endpoint failed or URL mismatch")
    if record.get("truncated") is not False:
        raise ValueError("incomplete response body")
    raw = record.get("body_utf8")
    if not isinstance(raw, str) or len(raw.encode()) > BODY_LIMIT:
        raise ValueError("response exceeds body limit")
    if hashlib.sha256(raw.encode()).hexdigest() != record.get("body_sha256"):
        raise ValueError("retained response hash mismatch")
    start, end = timestamp(record["requested_at"]), timestamp(record["received_at"])
    if start > end or (previous_end is not None and start < previous_end):
        raise ValueError("response times out of order")
    return strict_json(raw), end


def normalize(bundle):
    if bundle.get("schema") != "NightDeskCapture@1" or type(bundle.get("chain_id")) is not int or bundle["chain_id"] != 4663:
        raise ValueError("NightDeskCapture@1 on chain 4663 required")
    token = address(bundle["token"])
    symbol = bundle["symbol"]
    if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9.-]{1,20}", symbol):
        raise ValueError("invalid symbol")
    records = bundle["responses"]
    if not isinstance(records, list) or not 3 <= len(records) <= 4:
        raise ValueError("assets-before, prices and assets-after are required")
    parsed, end = [], None
    for record, url in zip(records[:3], (BASE + "assets", BASE + "prices/" + symbol, BASE + "assets")):
        data, end = response_data(record, url, end)
        parsed.append(data)
    before = matching(parsed[0]["assets"], symbol, token)
    quote = matching(parsed[1]["quotes"], symbol, token)
    after = matching(parsed[2]["assets"], symbol, token)
    for row in (before, after):
        if row.get("status") != "ASSET_STATUS_ACTIVE" or not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError("inactive or unidentified asset")
    fields = ("id", "currentMultiplier", "pendingMultiplier", "pendingMultiplierEffectiveTime", "status")
    if any(canonical(before.get(k)) != canonical(after.get(k)) for k in fields):
        raise ValueError("metadata changed during capture; retry in a later bounded capture")
    dec(after["currentMultiplier"])
    if quote.get("currency") != "USD" or type(quote.get("isTradingHalt")) is not bool:
        raise ValueError("explicit USD currency and halt state required")
    if timestamp(quote["generatedAt"]) > timestamp(records[1]["received_at"]):
        raise ValueError("server quote timestamp is in the future")
    ident = {"chain_id": 4663, "token": token}
    mult = {**ident, "value": after["currentMultiplier"], "basis": "CURRENT_REST_METADATA",
            "source": BASE + "assets", "source_at": records[2]["received_at"],
            "observed_at": records[2]["received_at"], "time_basis": "LOCAL_RECEIPT_NO_SERVER_UPDATE_TIME"}
    pending = after.get("pendingMultiplier")
    if not isinstance(pending, str):
        raise ValueError("pending multiplier must be explicitly empty or a decimal string")
    if pending:
        dec(pending)
        mult["pending"] = {"value": pending, "effective_at": after["pendingMultiplierEffectiveTime"]}
    elif after.get("pendingMultiplierEffectiveTime") not in (None, ""):
        raise ValueError("empty pending multiplier contradicts effective time")
    normalized = {"schema": "NightDeskInput@1", "as_of": records[2]["received_at"],
                  "asset": {**ident, "symbol": symbol, "decimals": 18},
                  "reference": {**ident, "basis": "RAW_EQUITY_USD", "bid": quote["bid"], "ask": quote["ask"],
                                "currency": "USD", "source": records[1]["url"], "source_at": quote["generatedAt"],
                                "observed_at": records[1]["received_at"], "time_basis": "SERVER_GENERATED",
                                "halted": quote["isTradingHalt"], "market_state": "UNKNOWN", "multiplier": mult}}
    # Tradability flags establish capabilities, not whether a market session is open now.
    report = analyze(normalized)
    if report["reference"]["status"] == "INVALID":
        raise ValueError(report["reference"]["reason"])
    return normalized


def normalize_actions(bundle):
    if len(bundle["responses"]) != 4:
        return {"status": "MISSING", "actions": []}
    try:
        data, _ = response_data(bundle["responses"][3], BASE + "corporate-actions",
                                timestamp(bundle["responses"][2]["received_at"]))
        rows = data["corpActions"]
        if not isinstance(rows, list):
            raise ValueError("corpActions must be an array")
        selected = []
        for row in rows:
            if not isinstance(row, dict) or row.get("tokenSymbol") != bundle["symbol"]:
                continue
            try:
                matching([row], bundle["symbol"], address(bundle["token"]))
            except ValueError:
                continue
            selected.append(row)
        return {"status": "RETAINED_REPORTED_ACTIONS", "actions": selected,
                "observed_at": bundle["responses"][3]["received_at"],
                "coverage": "Only rows returned by this single cached API response; no onchain reconciliation"}
    except (KeyError, ValueError, TypeError) as exc:
        return {"status": "UNAVAILABLE", "actions": [], "reason": str(exc)}


def collect(symbol, token, fetcher=None):
    token = address(token)
    if not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9.-]{1,20}", symbol):
        raise ValueError("invalid symbol")
    fetcher = fetcher or fetch
    bundle = {"schema": "NightDeskCapture@1", "chain_id": 4663, "token": token, "symbol": symbol,
              "responses": [], "capture_errors": [], "normalized_input": None, "status": "REFERENCE_UNAVAILABLE",
              "limits": ["At most four GET requests, no retry loop, 12-second timeout and 4 MB response cap per request.",
                         "REST metadata is current, unpinned and potentially cached; no historical block multiplier proof.",
                         "Hashes establish content equality only. No onchain mark, balance or execution evidence collected."]}
    for url in (BASE + "assets", BASE + "prices/" + symbol, BASE + "assets", BASE + "corporate-actions"):
        try:
            record = fetcher(url)
            bundle["responses"].append(record)
            if record.get("http_status") != 200 or record.get("truncated") is not False:
                bundle["error"] = "Endpoint returned non-success or truncated response"
                bundle["capture_errors"].append({"url": url, "error": bundle["error"]})
                break
        except (OSError, ValueError, TimeoutError, urllib.error.URLError) as exc:
            bundle["error"] = type(exc).__name__ + ": " + str(exc)
            bundle["capture_errors"].append({"url": url, "error": bundle["error"]})
            break
    try:
        bundle["normalized_input"] = normalize(bundle)
        bundle["status"] = "REFERENCE_CAPTURED"
    except (ValueError, KeyError, TypeError) as exc:
        bundle["normalization_error"] = type(exc).__name__ + ": " + str(exc)
        bundle.setdefault("error", bundle["normalization_error"])
    bundle["corporate_actions"] = normalize_actions(bundle)
    return bundle
