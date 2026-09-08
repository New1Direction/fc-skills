#!/usr/bin/env python3
"""Bounded, read-only SEC collection and retained Robinhood evidence joins."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path

from form4 import parse_form4

VERSION = "CatalystEvents@1"
CHAIN_ID = 4663
DEFAULTS = {"maxRequests": 100, "maxFilings": 25, "maxHistoricalFiles": 5,
            "maxBodyBytes": 4 * 1024 * 1024, "maxStorageBytes": 256 * 1024 * 1024,
            "requestsPerSecond": 5, "timeoutSeconds": 15, "pollSeconds": 15,
            "forms": ["4", "4/A", "8-K", "8-K/A", "SC 13D", "SC 13D/A"]}
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HASH = re.compile(r"0x[0-9a-fA-F]{64}\Z")
ACCESSION = re.compile(r"[0-9]{10}-[0-9]{2}-[0-9]{6}\Z")


def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def utcnow():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO8601 string with timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp must include timezone; no guessed SEC acceptance timezone")
    return parsed.astimezone(timezone.utc)


def cik(value):
    value = str(value)
    if not re.fullmatch(r"[0-9]{1,10}", value) or int(value) == 0:
        raise ValueError("CIK must contain 1–10 digits and be nonzero")
    return value.zfill(10)


def address(value):
    if not isinstance(value, str) or not ADDRESS.fullmatch(value):
        raise ValueError("exact EVM address required")
    return value.lower()


def bounded_int(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f"{name} must be an integer in [{low}, {high}]")
    return value


def load_json(path, max_bytes=32 * 1024 * 1024):
    with open(path, "rb") as source:
        raw = source.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError("input exceeds file size limit")
    return json.loads(raw)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        with temporary.open("x", encoding="utf-8") as target:
            target.write(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_config(config, live=True):
    if config.get("schemaVersion") != "CatalystConfig@1":
        raise ValueError("expected CatalystConfig@1")
    result = {**DEFAULTS, **config}
    for key, bounds in {"maxRequests": (1, 10000), "maxFilings": (1, 1000),
                        "maxHistoricalFiles": (0, 100), "maxBodyBytes": (1024, 16 * 1024 * 1024),
                        "maxStorageBytes": (1024 * 1024, 16 * 1024 ** 3),
                        "requestsPerSecond": (1, 10), "timeoutSeconds": (1, 60),
                        "pollSeconds": (1, 60)}.items():
        bounded_int(result[key], *bounds, key)
    if not isinstance(result["startDate"], str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", result["startDate"]):
        raise ValueError("startDate must use YYYY-MM-DD")
    date.fromisoformat(result["startDate"])
    issuers = result.get("issuers", [])
    if not isinstance(issuers, list) or not 1 <= len(issuers) <= 500:
        raise ValueError("configure between 1 and 500 issuer CIKs")
    result["issuers"] = [{"cik": cik(item["cik"])} for item in issuers]
    if len({item["cik"] for item in result["issuers"]}) != len(issuers):
        raise ValueError("duplicate issuer CIK")
    if not isinstance(result["forms"], list) or not result["forms"] or any(
            not isinstance(item, str) or not re.fullmatch(r"[A-Z0-9 /-]{1,20}", item)
            for item in result["forms"]):
        raise ValueError("forms must be explicit SEC form identifiers")
    ua = result.get("userAgent", "")
    if live and (not isinstance(ua, str) or len(ua) > 200 or "\r" in ua or "\n" in ua
                 or not re.search(r"[^\s@]+@[^\s@]+\.[^\s@]+", ua)
                 or re.search(r"example\.(com|org)|YOUR_|REPLACE", ua, re.I)):
        raise ValueError("configure a descriptive User-Agent with your real contact email")
    bindings = []
    for item in result.get("bindings", []):
        if item.get("chainId") != CHAIN_ID or not isinstance(item.get("securityTitle"), str) or not item["securityTitle"].strip():
            raise ValueError("binding requires chain 4663 and exact securityTitle")
        timestamp(item["verifiedAt"])
        if not item.get("evidence"):
            raise ValueError("binding requires retained verification evidence")
        bindings.append({**item, "issuerCik": cik(item["issuerCik"]), "tokenAddress": address(item["tokenAddress"])})
    identity_keys = [(item["issuerCik"], item["securityTitle"]) for item in bindings]
    if len(identity_keys) != len(set(identity_keys)):
        raise ValueError("ambiguous duplicate issuer/security binding")
    pools = []
    for item in result.get("pools", []):
        if item.get("chainId") != CHAIN_ID or not isinstance(item.get("poolId"), str) or not HASH.fullmatch(item["poolId"]):
            raise ValueError("pool requires chain 4663 and exact 32-byte V4 pool ID")
        timestamp(item["verifiedAt"])
        if not item.get("evidence"):
            raise ValueError("pool requires retained verification evidence")
        item = {**item, "poolId": item["poolId"].lower(), "token0": address(item["token0"]), "token1": address(item["token1"])}
        if item["token0"] == item["token1"]:
            raise ValueError("pool currencies must differ")
        pools.append(item)
    if len({item["poolId"] for item in pools}) != len(pools):
        raise ValueError("duplicate pool IDs")
    result["bindings"], result["pools"] = bindings, pools
    return result


def check_url(url):
    """No user-supplied URLs, arbitrary redirects, queries, or path traversal."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.query or parsed.fragment:
        raise ValueError("only canonical HTTPS SEC URLs are allowed")
    decoded = urllib.parse.unquote(parsed.path)
    if decoded != parsed.path or ".." in decoded.split("/") or "\\" in decoded or "//" in decoded:
        raise ValueError("noncanonical SEC path")
    valid = ((parsed.hostname == "data.sec.gov" and re.fullmatch(r"/submissions/CIK[0-9]{10}(?:-submissions-[0-9]{3})?\.json", decoded))
             or (parsed.hostname == "www.sec.gov" and re.fullmatch(r"/Archives/edgar/data/[0-9]{1,10}/[0-9]{18}/[A-Za-z0-9_.-]+", decoded)))
    if not valid:
        raise ValueError("URL is outside configured SEC submissions/archive scope")
    return url


def document_url(source_cik, accession, primary):
    if not ACCESSION.fullmatch(accession):
        raise ValueError("invalid accession")
    # The xslF345 path is a presentation wrapper; fetch the source XML instead.
    if not isinstance(primary, str) or not re.fullmatch(r"(?:xsl[A-Za-z0-9]+/)?[A-Za-z0-9_.-]+", primary):
        raise ValueError("invalid primary document path")
    filename = primary.rsplit("/", 1)[-1]
    return check_url(f"https://www.sec.gov/Archives/edgar/data/{int(cik(source_cik))}/{accession.replace('-', '')}/{filename}")


class LimitError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("SEC redirect refused; inspect source URL before changing configuration")


class RateLimiter:
    """A shared process ceiling; separate processes require an external shared budget."""
    def __init__(self):
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self, rate, clock=time.monotonic, sleep=time.sleep):
        with self.lock:
            now = clock()
            if self.next_at > now:
                sleep(self.next_at - now)
            self.next_at = clock() + max(0.101, 1 / rate)


PROCESS_LIMITER = RateLimiter()


class SecClient:
    def __init__(self, config, transport=None, limiter=None, clock=utcnow):
        self.config = config
        self.transport = transport or self._request
        self.limiter = limiter or PROCESS_LIMITER
        self.clock = clock
        self.requests = 0

    def _request(self, url, headers, timeout, limit):
        request = urllib.request.Request(url, headers=headers, method="GET")
        opener = urllib.request.build_opener(NoRedirect())
        deadline = time.monotonic() + timeout
        def read_body(response):
            chunks, size = [], 0
            while size <= limit:
                if time.monotonic() > deadline:
                    raise LimitError("HTTP response exceeded total time budget")
                # read1 prevents a trickling body keeping a large read alive indefinitely.
                chunk = response.read1(min(65536, limit + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            if time.monotonic() > deadline:
                raise LimitError("HTTP response exceeded total time budget")
            return b"".join(chunks)
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = read_body(response)
                return response.status, dict(response.headers), raw
        except urllib.error.HTTPError as error:
            with error:
                return error.code, dict(error.headers), read_body(error)

    def get(self, url):
        check_url(url)
        if self.requests >= self.config["maxRequests"]:
            raise LimitError("request budget exhausted")
        self.limiter.wait(self.config["requestsPerSecond"])
        self.requests += 1
        status, headers, raw = self.transport(url, {"User-Agent": self.config.get("userAgent", ""),
                                                  "Accept-Encoding": "identity", "Accept": "application/json, application/xml, text/html"},
                                              self.config["timeoutSeconds"], self.config["maxBodyBytes"])
        received_at = self.clock()
        timestamp(received_at)
        if len(raw) > self.config["maxBodyBytes"]:
            raise LimitError("response body exceeds configured byte limit; not retained as complete")
        return {"url": url, "status": status, "headers": headers, "body": raw, "receivedAt": received_at}


class Store:
    def __init__(self, path, max_bytes=DEFAULTS["maxStorageBytes"]):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        self.db = sqlite3.connect(self.path, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS raw(sha256 TEXT PRIMARY KEY, body BLOB NOT NULL);
          CREATE TABLE IF NOT EXISTS fetches(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, url TEXT NOT NULL,
            received_at TEXT NOT NULL, status INTEGER NOT NULL, raw_sha TEXT NOT NULL, headers TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS filings(accession TEXT PRIMARY KEY, source_cik TEXT NOT NULL,
            first_observed TEXT NOT NULL, metadata TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
            source_url TEXT, raw_sha TEXT, collected_at TEXT, parsed TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS discoveries(accession TEXT NOT NULL, fetch_id INTEGER NOT NULL,
            PRIMARY KEY(accession, fetch_id));
          CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT,
            config TEXT NOT NULL, report TEXT);
        """)
        if "details_available_at" not in {row[1] for row in self.db.execute("PRAGMA table_info(filings)")}:
            self.db.execute("ALTER TABLE filings ADD COLUMN details_available_at TEXT")
        self.db.commit()

    def close(self):
        self.db.close()

    def capacity(self, extra=0):
        total = sum(path.stat().st_size for path in [self.path, Path(str(self.path) + "-wal")] if path.exists())
        if total + extra + 65536 > self.max_bytes:
            raise LimitError("storage limit reached; stop and archive or explicitly increase capacity")

    def retain(self, run_id, response):
        self.capacity(len(response["body"]) * 2 + 4096)
        sha = hashlib.sha256(response["body"]).hexdigest()
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO raw VALUES (?, ?)", (sha, response["body"]))
            cursor = self.db.execute("INSERT INTO fetches(run_id,url,received_at,status,raw_sha,headers) VALUES (?,?,?,?,?,?)",
                                     (run_id, response["url"], response["receivedAt"], response["status"], sha, dumps(response["headers"])))
        return cursor.lastrowid, sha

    def discover(self, metadata, source_cik, fetch_id, observed):
        self.capacity(len(dumps(metadata)) * 2 + 4096)
        accession = metadata["accessionNumber"]
        with self.db:
            old = self.db.execute("SELECT metadata FROM filings WHERE accession=?", (accession,)).fetchone()
            if old:
                original = json.loads(old["metadata"])
                if any(original.get(key) != metadata.get(key) for key in ("form", "primaryDocument", "acceptanceDateTime")):
                    raise ValueError("accession metadata changed; retained original requires review")
            else:
                self.db.execute("INSERT INTO filings(accession,source_cik,first_observed,metadata) VALUES (?,?,?,?)",
                                (accession, source_cik, observed, dumps(metadata)))
            self.db.execute("INSERT OR IGNORE INTO discoveries VALUES (?,?)", (accession, fetch_id))


def column_rows(columns):
    if not isinstance(columns, dict) or not isinstance(columns.get("accessionNumber"), list):
        raise ValueError("invalid submissions column arrays")
    count = len(columns["accessionNumber"])
    required = ("accessionNumber", "form", "filingDate", "primaryDocument")
    if any(not isinstance(columns.get(key), list) or len(columns[key]) != count for key in required):
        raise ValueError("misaligned required submissions arrays")
    if any(isinstance(value, list) and len(value) != count for value in columns.values()):
        raise ValueError("misaligned optional submissions arrays")
    rows = [{key: values[index] for key, values in columns.items() if isinstance(values, list)} for index in range(count)]
    for row in rows:
        if not isinstance(row["accessionNumber"], str) or not ACCESSION.fullmatch(row["accessionNumber"]):
            raise ValueError("invalid accession in submissions")
        date.fromisoformat(row["filingDate"])
    return rows


@contextlib.contextmanager
def collector_lock(path):
    """Linux/macOS process lock: one collector owns each durable database."""
    with open(str(path) + ".collector.lock", "a", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LimitError("another collector owns this database; share one SEC access budget") from None
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def collect_once(config, store, client=None, clock=utcnow):
    with collector_lock(store.path):
        return _collect_once(config, store, client, clock)


def _collect_once(config, store, client=None, clock=utcnow):
    client = client or SecClient(config, clock=clock)
    client.requests = 0
    run_id = uuid.uuid4().hex
    started = clock()
    report = {"schemaVersion": "CatalystRun@1", "id": run_id, "startedAt": started,
              "scope": "CONFIGURED_CIK_SUBMISSIONS_ONLY", "startDate": config["startDate"],
              "issuers": [], "errors": [], "documentsCollected": 0}
    store.capacity(len(dumps(config)) * 2 + 65536)
    with store.db:
        store.db.execute("INSERT INTO runs(id,started_at,config) VALUES (?,?,?)", (run_id, started, dumps(config)))

    def fetch(url):
        response = client.get(url)
        fetch_id, sha = store.retain(run_id, response)
        if response["status"] != 200:
            # Never retry 403/429 in a tight loop; end this cycle on access/rate denial.
            if response["status"] in (403, 429):
                raise LimitError(f"SEC HTTP {response['status']}; stop cycle, respect Retry-After and review access budget")
            raise ValueError(f"SEC HTTP {response['status']}")
        return response, fetch_id, sha

    budget_stop = False
    for issuer in config["issuers"]:
        source_cik = issuer["cik"]
        detail = {"cik": source_cik, "status": "PENDING", "selectedFilings": 0,
                  "historicalFilesSelected": 0, "historicalFilesRead": 0}
        report["issuers"].append(detail)
        try:
            response, fetch_id, _ = fetch(f"https://data.sec.gov/submissions/CIK{source_cik}.json")
            data = json.loads(response["body"])
            if cik(data["cik"]) != source_cik:
                raise ValueError("submissions CIK differs from requested CIK")
            recent = column_rows(data["filings"]["recent"])
            pages = [(recent, fetch_id, response["receivedAt"])]
            files = data["filings"].get("files", [])
            selected_files = []
            for item in files:
                if date.fromisoformat(item["filingTo"]) >= date.fromisoformat(config["startDate"]):
                    selected_files.append(item)
            selected_files.sort(key=lambda item: item["filingTo"], reverse=True)
            detail["historicalFilesSelected"] = len(selected_files)
            # Persist current discoveries before attempting historical network reads.
            def ingest(rows, source_fetch_id, observed_at):
                for row in rows:
                    if row["form"] in config["forms"] and row["filingDate"] >= config["startDate"]:
                        store.discover(row, source_cik, source_fetch_id, observed_at)
                        detail["selectedFilings"] += 1
            ingest(*pages[0])
            for item in selected_files[:config["maxHistoricalFiles"]]:
                if not re.fullmatch(rf"CIK{source_cik}-submissions-[0-9]{{3}}\.json", item["name"]):
                    raise ValueError("unexpected historical submissions filename")
                historical, page_fetch_id, _ = fetch(f"https://data.sec.gov/submissions/{item['name']}")
                ingest(column_rows(json.loads(historical["body"])), page_fetch_id, historical["receivedAt"])
                detail["historicalFilesRead"] += 1
            detail["status"] = "SOURCE_RANGE_READ" if len(selected_files) <= config["maxHistoricalFiles"] else "HISTORY_TRUNCATED"
        except (ValueError, KeyError, TypeError, OSError, LimitError) as error:
            detail["status"], detail["error"] = "PARTIAL", str(error)
            report["errors"].append({"phase": "discovery", "cik": source_cik, "error": str(error)})
            if isinstance(error, LimitError):
                budget_stop = True
                break

    # Retry retained failures before newer documents; pending metadata survives restarts.
    active_ciks = {item["cik"] for item in config["issuers"]}
    pending = []
    for row in store.db.execute("SELECT * FROM filings WHERE status!='COLLECTED' ORDER BY attempts, first_observed, accession"):
        metadata = json.loads(row["metadata"])
        if row["source_cik"] in active_ciks and metadata["form"] in config["forms"] and metadata["filingDate"] >= config["startDate"]:
            pending.append(row)
    report["pendingAtDocumentPhase"] = len(pending)
    if not budget_stop:
        for row in pending[:config["maxFilings"]]:
            metadata = json.loads(row["metadata"])
            try:
                url = document_url(row["source_cik"], row["accession"], metadata["primaryDocument"])
                response, _, sha = fetch(url)
                # Retain the successful primary body even if parsing fails next.
                with store.db:
                    store.db.execute("UPDATE filings SET source_url=?,raw_sha=?,collected_at=?,details_available_at=NULL WHERE accession=?",
                                     (url, sha, response["receivedAt"], row["accession"]))
                parsed = parse_form4(response["body"]) if metadata["form"] in ("4", "4/A") else None
                if parsed and parsed["documentType"] != metadata["form"]:
                    raise ValueError("ownership XML form differs from discovery metadata")
                store.capacity(len(dumps(parsed)) * 2 + 65536)
                with store.db:
                    store.db.execute("UPDATE filings SET status='COLLECTED',source_url=?,raw_sha=?,collected_at=?,details_available_at=?,parsed=?,error=NULL,attempts=attempts+1 WHERE accession=?",
                                     (url, sha, response["receivedAt"], clock(), dumps(parsed), row["accession"]))
                report["documentsCollected"] += 1
            except (ValueError, KeyError, TypeError, OSError, LimitError) as error:
                with store.db:
                    store.db.execute("UPDATE filings SET status='ERROR',error=?,attempts=attempts+1 WHERE accession=?", (str(error), row["accession"]))
                report["errors"].append({"phase": "document", "accession": row["accession"], "error": str(error)})
                if isinstance(error, LimitError):
                    budget_stop = True
                    break
    remaining = sum(1 for row in pending if store.db.execute("SELECT status FROM filings WHERE accession=?", (row["accession"],)).fetchone()[0] != "COLLECTED")
    report.update({"completedAt": clock(), "requests": client.requests, "pendingDocuments": remaining,
                   "status": "PARTIAL" if report["errors"] or remaining or len(report["issuers"]) != len(config["issuers"])
                   or any(item["status"] != "SOURCE_RANGE_READ" for item in report["issuers"]) else "SOURCE_RANGE_READ"})
    report["limitations"] = ["No global EDGAR coverage, latest-feed monitoring, or independent source completeness proof.",
                              "First observed is local API retrieval time, not transaction time or SEC publication time.",
                              "This bounded process does not establish continuous uptime or a latency SLA."]
    with store.db:
        store.db.execute("UPDATE runs SET completed_at=?,report=? WHERE id=?", (report["completedAt"], dumps(report), run_id))
    store.db.execute("PRAGMA wal_checkpoint(PASSIVE)")
    return report


def associations(parsed, source_cik, observed_at, config):
    issuer_cik = cik(parsed["issuer"]["cik"]) if parsed else source_cik
    titles = set()
    if parsed:
        for row in parsed["rows"]:
            title = row.get("underlyingSecurityTitle") if row.get("table") == "derivative" else row.get("securityTitle")
            if title:
                titles.add(title)
    matches = []
    for binding in config["bindings"]:
        if binding["issuerCik"] != issuer_cik or parsed and binding["securityTitle"] not in titles:
            continue
        pools = [item for item in config["pools"] if binding["tokenAddress"] in (item["token0"], item["token1"])]
        # A binding can predate a pool, so retain timing independently per pool.
        pool_records = [{"poolId": item["poolId"], "token0": item["token0"], "token1": item["token1"],
                         "mappingKnownAt": max((binding["verifiedAt"], item["verifiedAt"]), key=timestamp),
                         "evidence": item["evidence"]} for item in pools]
        matches.append({"chainId": CHAIN_ID, "stockTokenAddress": binding["tokenAddress"],
                        "securityTitle": binding["securityTitle"], "associationScope": "REPORTED_SECURITY" if parsed else "ISSUER_LEVEL_ONLY",
                        "poolIds": [item["poolId"] for item in pools], "pools": pool_records,
                        "mappingKnownAt": binding["verifiedAt"], "mappingTiming": "KNOWN_AT_OBSERVATION" if timestamp(binding["verifiedAt"]) <= timestamp(observed_at) else "RETROSPECTIVE",
                        "evidence": binding["evidence"]})
    return matches


def export_events(store, config=None):
    last = store.db.execute("SELECT * FROM runs ORDER BY rowid DESC LIMIT 1").fetchone()
    if not last:
        raise ValueError("no retained collection run")
    config = validate_config(config or json.loads(last["config"]), live=False)
    events = []
    for row in store.db.execute("SELECT * FROM filings ORDER BY first_observed,accession"):
        meta = json.loads(row["metadata"])
        parsed = json.loads(row["parsed"]) if row["parsed"] else None
        accepted = meta.get("acceptanceDateTime") or None
        warnings = []
        if accepted:
            try:
                if timestamp(accepted) > timestamp(row["first_observed"]):
                    warnings.append("ACCEPTANCE_AFTER_LOCAL_OBSERVATION_CHECK_CLOCKS")
            except ValueError:
                warnings.append("ACCEPTANCE_TIMESTAMP_HAS_UNKNOWN_TIMEZONE_OR_FORMAT")
                accepted = None
        else:
            warnings.append("ACCEPTANCE_TIMESTAMP_UNAVAILABLE")
        if meta["form"].endswith("/A"):
            warnings.append("AMENDMENT_SEPARATE_EVENT_DO_NOT_SUM_WITH_ORIGINAL")
        if row["status"] != "COLLECTED":
            warnings.append("DOCUMENT_NOT_COLLECTED")
        if parsed and cik(parsed["issuer"]["cik"]) != row["source_cik"]:
            warnings.append("XML_ISSUER_DIFFERS_FROM_DISCOVERY_CIK")
        event_associations = associations(parsed, row["source_cik"], row["first_observed"], config) if row["status"] == "COLLECTED" else []
        discoveries = [dict(item) for item in store.db.execute("SELECT f.url,f.received_at AS observedAt,f.raw_sha AS rawSha256 FROM fetches f JOIN discoveries d ON d.fetch_id=f.id WHERE d.accession=? ORDER BY f.id", (row["accession"],))]
        events.append({"id": "sec:" + row["accession"], "accession": row["accession"],
                       "issuerCik": cik(parsed["issuer"]["cik"]) if parsed else row["source_cik"],
                       "discoveryCik": row["source_cik"], "form": meta["form"], "filingDate": meta["filingDate"],
                       "acceptedAt": accepted, "acceptedAtRaw": meta.get("acceptanceDateTime"),
                       "firstObservedAt": row["first_observed"], "collectedAt": row["collected_at"],
                       "detailsAvailableAt": row["details_available_at"],
                       "status": row["status"], "source": row["source_url"], "rawSha256": row["raw_sha"],
                       "metadata": meta, "parsed": parsed, "associations": event_associations,
                       "discoveryEvidence": discoveries, "error": row["error"], "warnings": warnings})
    return {"schemaVersion": VERSION, "generatedAt": utcnow(), "events": events,
            "coverage": json.loads(last["report"]) if last["report"] else {"status": "INTERRUPTED_RUN", "startedAt": last["started_at"]},
            "limitations": ["Mappings are supplied verification evidence, not automatically established by SEC or token tickers.",
                            "Hashes permit integrity checks; they do not prove filing accuracy or investment merit."]}


def positive_decimal(value):
    if not isinstance(value, str) or len(value) > 200:
        raise ValueError("price must be a bounded decimal string")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise ValueError("invalid decimal price") from None
    if not number.is_finite() or number <= 0 or abs(number.adjusted()) > 100:
        raise ValueError("price must be finite, positive and bounded")
    return number


def analyze(events, observations, horizon_seconds=60, tolerance_seconds=30, max_base_age_seconds=300):
    if events.get("schemaVersion") != VERSION or observations.get("schemaVersion") != "CatalystObservations@1":
        raise ValueError("expected CatalystEvents@1 and CatalystObservations@1")
    for name, value in (("horizon", horizon_seconds), ("tolerance", tolerance_seconds), ("base age", max_base_age_seconds)):
        bounded_int(value, 1, 86400, name)
    records = []
    rows = observations.get("observations", [])
    if not isinstance(rows, list) or len(rows) > 100000:
        raise ValueError("observations must be a bounded list")
    # Fail on contradictory canonical claims; silently picking one manufactures evidence.
    seen = {}
    for row in rows:
        if row.get("chainId") != CHAIN_ID or not HASH.fullmatch(row.get("poolId", "")) or not HASH.fullmatch(row.get("blockHash", "")):
            raise ValueError("observation requires chain 4663, pool ID and block hash")
        timestamp(row["observedAt"])
        timestamp(row["blockTimestamp"])
        if timestamp(row["observedAt"]) < timestamp(row["blockTimestamp"]):
            raise ValueError("observation clock precedes block timestamp")
        bounded_int(row["blockNumber"], 0, 2 ** 63 - 1, "blockNumber")
        if type(row.get("canonical")) is not bool or not row.get("source") or not row.get("priceBasis"):
            raise ValueError("observation needs explicit canonical boolean, source and priceBasis")
        address(row["baseTokenAddress"])
        address(row["quoteTokenAddress"])
        positive_decimal(row["price"])
        key = (row["poolId"].lower(), row["blockNumber"])
        if row["canonical"]:
            signature = (row["blockHash"], row["price"], row["baseTokenAddress"].lower(), row["quoteTokenAddress"].lower(), row["priceBasis"])
            if key in seen and seen[key] != signature:
                raise ValueError("conflicting canonical observations at same pool/block; normalize to one end-of-block state")
            seen[key] = signature
    for event in events["events"]:
        discovery = timestamp(event["firstObservedAt"])
        detail_at = event.get("detailsAvailableAt")
        anchor = max(discovery, timestamp(detail_at)) if detail_at else discovery
        for association in event.get("associations", []):
            for pool in association.get("pools", []):
                record = {"eventId": event["id"], "stockTokenAddress": association["stockTokenAddress"], "poolId": pool["poolId"],
                          "anchorAt": anchor.isoformat().replace("+00:00", "Z"), "anchorBasis": "LOCAL_DOCUMENT_DETAILS_AVAILABLE",
                          "firstObservedAt": event["firstObservedAt"],
                          "discoveryToDetailsSeconds": (anchor - discovery).total_seconds() if detail_at else None,
                          "horizonSeconds": horizon_seconds,
                          "status": "INSUFFICIENT_DATA", "localPriceChangePct": None, "reasons": []}
                records.append(record)
                if event["status"] != "COLLECTED":
                    record["reasons"].append("DOCUMENT_NOT_COLLECTED")
                if not detail_at:
                    record["reasons"].append("DETAIL_AVAILABILITY_TIME_UNAVAILABLE")
                if timestamp(pool["mappingKnownAt"]) > anchor:
                    record["reasons"].append("MAPPING_NOT_KNOWN_AT_FIRST_OBSERVATION")
                if "ACCEPTANCE_AFTER_LOCAL_OBSERVATION_CHECK_CLOCKS" in event.get("warnings", []):
                    record["reasons"].append("EVENT_CLOCK_CONFLICT")
                candidates = [item for item in rows if item["poolId"].lower() == pool["poolId"].lower() and item["canonical"]
                              and {item["baseTokenAddress"].lower(), item["quoteTokenAddress"].lower()} == {pool["token0"], pool["token1"]}]
                before = [item for item in candidates if timestamp(item["observedAt"]) <= anchor
                          and timedelta(0) <= anchor - timestamp(item["blockTimestamp"]) <= timedelta(seconds=max_base_age_seconds)]
                target = anchor + timedelta(seconds=horizon_seconds)
                after = [item for item in candidates if target <= timestamp(item["blockTimestamp"]) <= target + timedelta(seconds=tolerance_seconds)
                         and timestamp(item["observedAt"]) <= target + timedelta(seconds=tolerance_seconds)]
                baseline = max(before, key=lambda item: (timestamp(item["blockTimestamp"]), item["blockNumber"])) if before else None
                outcome = min(after, key=lambda item: (timestamp(item["blockTimestamp"]), item["blockNumber"])) if after else None
                if baseline is None:
                    record["reasons"].append("NO_BASELINE_KNOWN_BEFORE_EVENT")
                if outcome is None:
                    record["reasons"].append("NO_TIMELY_POST_EVENT_OBSERVATION")
                if baseline and outcome:
                    if any(baseline[key] != outcome[key] for key in ("priceBasis", "baseTokenAddress", "quoteTokenAddress")):
                        record["reasons"].append("PRICE_UNITS_OR_ORIENTATION_CHANGED")
                    covering = []
                    for interval in observations.get("coverage", []):
                        if interval.get("poolId", "").lower() != pool["poolId"].lower():
                            continue
                        if interval.get("canonicalComplete") is True and interval.get("source") and timestamp(interval["from"]) <= timestamp(baseline["blockTimestamp"]) and timestamp(interval["to"]) >= timestamp(outcome["blockTimestamp"]):
                            covering.append(interval)
                    if not covering:
                        record["reasons"].append("CANONICAL_INTERVAL_COVERAGE_UNAVAILABLE")
                    record.update({"baseline": baseline, "outcome": outcome, "coverage": covering})
                    if not record["reasons"]:
                        with localcontext() as context:
                            context.prec = 80
                            change = (positive_decimal(outcome["price"]) / positive_decimal(baseline["price"]) - 1) * 100
                        record.update({"status": "OBSERVED_LOCAL_PRICE_CHANGE", "localPriceChangePct": format(change, "f"),
                                       "priceBasis": baseline["priceBasis"], "quoteTokenAddress": baseline["quoteTokenAddress"]})
    return {"schemaVersion": "CatalystResponse@1", "generatedAt": utcnow(), "results": records,
            "limitations": ["Association and subsequent movement do not establish causation or trading profitability.",
                            "Local quote-unit price change is not USD return or stock-adjusted excess return.",
                            "Canonical flags and interval coverage are supplied adapter evidence; native code does not query or verify chain finality.",
                            "Missing history is not zero response; failed or unavailable observations remain unqualified."]}


def demo(out):
    """Deterministic local HTTP fixture, never contacts SEC or a blockchain."""
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    db_path = out / "catalyst.sqlite"
    if db_path.exists():
        raise ValueError("demo requires a fresh output directory (database already exists)")
    stock, meme, pool_id = "0x" + "11" * 20, "0x" + "22" * 20, "0x" + "33" * 32
    config = validate_config({"schemaVersion": "CatalystConfig@1", "startDate": "2026-09-01", "issuers": [{"cik": "1234567"}],
                              "bindings": [{"issuerCik": "1234567", "securityTitle": "Common Stock", "chainId": CHAIN_ID,
                                            "tokenAddress": stock, "verifiedAt": "2026-09-01T00:00:00Z", "evidence": "SYNTHETIC_BINDING"}],
                              "pools": [{"chainId": CHAIN_ID, "poolId": pool_id, "token0": stock, "token1": meme,
                                         "verifiedAt": "2026-09-01T00:00:00Z", "evidence": "SYNTHETIC_POOL_REGISTRY"}]}, live=False)
    raw = (Path(__file__).resolve().parents[1] / "assets" / "form4-synthetic.xml").read_bytes()
    # Fixture issuer is validated instead of patched invisibly in the transport.
    parsed = parse_form4(raw)
    source_cik = cik(parsed["issuer"]["cik"])
    config["issuers"] = [{"cik": source_cik}]
    config["bindings"][0]["issuerCik"] = source_cik
    accession = "0001234567-26-000001"
    submissions = {"cik": int(source_cik), "filings": {"recent": {"accessionNumber": [accession], "form": ["4"],
                   "filingDate": ["2026-09-08"], "primaryDocument": ["xslF345X05/ownership.xml"],
                   "acceptanceDateTime": ["2026-09-08T14:00:00Z"]}, "files": []}}
    observed = "2026-09-08T14:00:02Z"
    def transport(url, headers, timeout, limit):
        if url == f"https://data.sec.gov/submissions/CIK{source_cik}.json":
            return 200, {"Content-Type": "application/json"}, dumps(submissions).encode()
        if url == document_url(source_cik, accession, "ownership.xml"):
            return 200, {"Content-Type": "application/xml"}, raw
        raise ValueError("unconfigured synthetic URL")
    class ImmediateLimiter:
        def wait(self, rate):
            pass
    store = Store(db_path)
    try:
        run = collect_once(config, store, SecClient(config, transport, ImmediateLimiter(), lambda: observed), clock=lambda: observed)
        events = export_events(store, config)
    finally:
        store.close()
    observations = {"schemaVersion": "CatalystObservations@1", "observations": [], "coverage": [{"poolId": pool_id,
                    "from": "2026-09-08T13:59:58Z", "to": "2026-09-08T14:01:05Z", "canonicalComplete": True, "source": "SYNTHETIC_CANONICAL_INTERVAL"}]}
    for number, at, price in ((100, "2026-09-08T14:00:01Z", "2"), (101, "2026-09-08T14:01:03Z", "2.1")):
        observations["observations"].append({"chainId": CHAIN_ID, "poolId": pool_id, "observedAt": at, "blockTimestamp": at,
            "blockNumber": number, "blockHash": "0x" + f"{number:064x}", "canonical": True, "price": price,
            "baseTokenAddress": meme, "quoteTokenAddress": stock, "priceBasis": "RAW_STOCK_TOKENS_PER_RAW_MEME_TOKEN",
            "source": "SYNTHETIC_END_OF_BLOCK_STATE"})
    response = analyze(events, observations)
    for filename, value in (("config.json", config), ("events.json", events), ("observations.json", observations), ("response.json", response), ("run.json", run)):
        write_json(out / filename, value)
    return {"status": "SYNTHETIC_DEMO_COMPLETE", "out": str(out), "events": len(events["events"]), "results": len(response["results"]),
            "networkRequests": 0, "localPriceChangePct": response["results"][0]["localPriceChangePct"] if response["results"] else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    demo_parser = sub.add_parser("demo", help="run complete synthetic offline flow")
    demo_parser.add_argument("--out", required=True)
    collect_parser = sub.add_parser("collect", help="bounded read-only SEC collection")
    collect_parser.add_argument("--config", required=True)
    collect_parser.add_argument("--db", required=True)
    collect_parser.add_argument("--cycles", type=int, default=1)
    export_parser = sub.add_parser("export", help="export retained events without networking")
    export_parser.add_argument("--db", required=True)
    export_parser.add_argument("--out", required=True)
    export_parser.add_argument("--config", help="explicit retained binding/registry update")
    parse_parser = sub.add_parser("parse", help="parse retained Form 4 source XML")
    parse_parser.add_argument("--xml", required=True)
    parse_parser.add_argument("--out", required=True)
    analyze_parser = sub.add_parser("analyze", help="join retained event and pool observations")
    analyze_parser.add_argument("--events", required=True)
    analyze_parser.add_argument("--observations", required=True)
    analyze_parser.add_argument("--out", required=True)
    analyze_parser.add_argument("--horizon-seconds", type=int, default=60)
    args = parser.parse_args(argv)
    try:
        if args.command == "demo":
            print(dumps(demo(args.out)))
        elif args.command == "collect":
            config = validate_config(load_json(args.config))
            bounded_int(args.cycles, 1, 100, "cycles")
            store = Store(args.db, config["maxStorageBytes"])
            try:
                partial = False
                for index in range(args.cycles):
                    result = collect_once(config, store)
                    print(dumps(result), flush=True)
                    partial = partial or result["status"] != "SOURCE_RANGE_READ"
                    if any("HTTP 403" in item["error"] or "HTTP 429" in item["error"] or "storage limit" in item["error"] for item in result["errors"]):
                        break
                    if index + 1 < args.cycles:
                        time.sleep(config["pollSeconds"])
                return 2 if partial else 0
            finally:
                store.close()
        elif args.command == "export":
            if not Path(args.db).is_file():
                raise ValueError("database does not exist")
            store = Store(args.db)
            try:
                result = export_events(store, load_json(args.config) if args.config else None)
                write_json(args.out, result)
                print(dumps({"status": "EXPORTED", "events": len(result["events"]), "out": args.out}))
            finally:
                store.close()
        elif args.command == "parse":
            with open(args.xml, "rb") as source:
                raw = source.read(4 * 1024 * 1024 + 1)
            write_json(args.out, parse_form4(raw))
            print(dumps({"status": "PARSED", "out": args.out}))
        elif args.command == "analyze":
            result = analyze(load_json(args.events), load_json(args.observations), args.horizon_seconds)
            write_json(args.out, result)
            print(dumps({"status": "ANALYZED", "results": len(result["results"]), "out": args.out}))
        return 0
    except (ValueError, OSError, KeyError, TypeError, sqlite3.Error, LimitError) as error:
        print(dumps({"status": "ERROR", "error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
