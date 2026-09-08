import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import catalyst as c

RAW = (Path(__file__).resolve().parents[1] / "assets" / "form4-synthetic.xml").read_bytes()
CIK = c.cik(c.parse_form4(RAW)["issuer"]["cik"])
ACC = "0001234567-26-000001"
STOCK, MEME, POOL = "0x" + "11" * 20, "0x" + "22" * 20, "0x" + "33" * 32
AT = "2026-09-08T14:00:02Z"


def config(**kwargs):
    return c.validate_config({"schemaVersion": "CatalystConfig@1", "startDate": "2026-09-01", "issuers": [{"cik": CIK}],
         "bindings": [{"issuerCik": CIK, "securityTitle": "Common Stock", "chainId": 4663,
                       "tokenAddress": STOCK, "verifiedAt": "2026-09-01T00:00:00Z", "evidence": "SYNTHETIC"}],
         "pools": [{"chainId": 4663, "poolId": POOL, "token0": STOCK, "token1": MEME,
                    "verifiedAt": "2026-09-01T00:00:00Z", "evidence": "SYNTHETIC"}], **kwargs}, live=False)


def submissions(accessions=None):
    accessions = accessions or [ACC]
    count = len(accessions)
    return {"cik": int(CIK), "filings": {"recent": {"accessionNumber": accessions, "form": ["4"] * count,
        "filingDate": ["2026-09-08"] * count, "primaryDocument": ["xslF345X05/ownership.xml"] * count,
        "acceptanceDateTime": ["2026-09-08T14:00:00Z"] * count}, "files": []}}


class Immediate:
    def wait(self, rate):
        pass


class Transport:
    def __init__(self, data=None, doc=RAW):
        self.data = data or submissions()
        self.doc = doc
        self.doc_status = 200
        self.calls = []
        self.pages = {}

    def __call__(self, url, headers, timeout, limit):
        self.calls.append(url)
        if url in self.pages:
            return 200, {}, c.dumps(self.pages[url]).encode()
        if url == f"https://data.sec.gov/submissions/CIK{CIK}.json":
            return 200, {}, c.dumps(self.data).encode()
        if "Archives" in url:
            return self.doc_status, {}, self.doc
        raise AssertionError("unexpected URL " + url)


class CollectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "state.sqlite"
        self.store = c.Store(self.path)
        self.transport = Transport()
        self.config = config()

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def collect(self, at=AT):
        client = c.SecClient(self.config, self.transport, Immediate(), lambda: at)
        return c.collect_once(self.config, self.store, client, lambda: at)

    def test_real_pipeline_retains_raw_and_first_observed_on_restart(self):
        result = self.collect()
        self.assertEqual(result["status"], "SOURCE_RANGE_READ")
        self.assertEqual(result["requests"], 2)
        exported = c.export_events(self.store)
        event = exported["events"][0]
        self.assertEqual(event["rawSha256"], hashlib.sha256(RAW).hexdigest())
        self.assertEqual(event["associations"][0]["stockTokenAddress"], STOCK)
        self.assertEqual(event["associations"][0]["poolIds"], [POOL])
        self.assertNotEqual(event["acceptedAt"], event["firstObservedAt"])
        self.store.close()
        self.store = c.Store(self.path)
        self.collect("2026-09-08T15:00:00Z")
        event = c.export_events(self.store)["events"][0]
        self.assertEqual(event["firstObservedAt"], AT)
        self.assertEqual(len(event["discoveryEvidence"]), 2)
        self.assertEqual(sum("Archives" in url for url in self.transport.calls), 1)
        retained = self.store.db.execute("SELECT body FROM raw WHERE sha256=?", (event["rawSha256"],)).fetchone()[0]
        self.assertEqual(retained, RAW)

    def test_failed_document_recovers_without_resetting_first_seen(self):
        self.transport.doc_status = 503
        first = self.collect()
        self.assertEqual(first["pendingDocuments"], 1)
        self.assertEqual(first["status"], "PARTIAL")
        self.transport.doc_status = 200
        self.assertEqual(self.collect("2026-09-08T15:00:00Z")["pendingDocuments"], 0)
        event = c.export_events(self.store)["events"][0]
        self.assertEqual(event["firstObservedAt"], AT)
        self.assertEqual(event["collectedAt"], "2026-09-08T15:00:00Z")

    def test_request_budget_preserves_pending_discovery(self):
        self.config["maxRequests"] = 1
        report = self.collect()
        self.assertEqual(report["requests"], 1)
        self.assertEqual(report["pendingDocuments"], 1)
        self.assertEqual(c.export_events(self.store)["events"][0]["status"], "ERROR")
        self.config["maxRequests"] = 2
        self.assertEqual(self.collect()["documentsCollected"], 1)

    def test_document_limit_visible_and_fair(self):
        self.transport.data = submissions([ACC, "0001234567-26-000002"])
        self.config["maxFilings"] = 1
        self.assertEqual(self.collect()["pendingDocuments"], 1)
        self.assertEqual(self.collect()["pendingDocuments"], 0)
        self.assertEqual(len(c.export_events(self.store)["events"]), 2)

    def test_amendments_separate_and_never_summed(self):
        self.collect()
        self.transport.data = submissions(["0001234567-26-000002"])
        self.transport.data["filings"]["recent"]["form"] = ["4/A"]
        self.transport.doc = RAW.replace(b"<documentType>4</documentType>", b"<documentType>4/A</documentType>")
        self.collect()
        events = c.export_events(self.store)["events"]
        self.assertEqual(len(events), 2)
        self.assertIn("AMENDMENT_SEPARATE_EVENT_DO_NOT_SUM_WITH_ORIGINAL", events[1]["warnings"])

    def test_ownership_form_mismatch_keeps_error(self):
        self.transport.data["filings"]["recent"]["form"] = ["4/A"]
        self.assertEqual(self.collect()["status"], "PARTIAL")
        self.assertIn("differs", c.export_events(self.store)["events"][0]["error"])

    def test_failed_parse_keeps_primary_body_provenance(self):
        self.transport.doc = b"<html>not ownership XML</html>"
        self.collect()
        event = c.export_events(self.store)["events"][0]
        self.assertEqual(event["status"], "ERROR")
        self.assertEqual(event["rawSha256"], hashlib.sha256(self.transport.doc).hexdigest())
        self.assertEqual(event["collectedAt"], AT)
        self.assertIsNone(event["detailsAvailableAt"])

    def test_narrative_document_retained_without_fake_parser(self):
        self.transport.data["filings"]["recent"]["form"] = ["8-K"]
        self.transport.doc = b"<html>Material event narrative</html>"
        self.collect()
        event = c.export_events(self.store)["events"][0]
        self.assertIsNone(event["parsed"])
        self.assertEqual(event["status"], "COLLECTED")
        self.assertEqual(event["associations"][0]["associationScope"], "ISSUER_LEVEL_ONLY")

    def test_no_guessing_unknown_security_class(self):
        self.config["bindings"][0]["securityTitle"] = "Class Z"
        self.collect()
        self.assertEqual(c.export_events(self.store)["events"][0]["associations"], [])

    def test_retrospective_mapping_labelled(self):
        self.config["bindings"][0]["verifiedAt"] = "2026-09-09T00:00:00Z"
        self.collect()
        self.assertEqual(c.export_events(self.store)["events"][0]["associations"][0]["mappingTiming"], "RETROSPECTIVE")

    def test_source_history_limit_not_complete(self):
        self.transport.data["filings"]["files"] = [{"name": f"CIK{CIK}-submissions-001.json", "filingFrom": "2025-01-01", "filingTo": "2026-09-02"}]
        self.config["maxHistoricalFiles"] = 0
        result = self.collect()
        self.assertEqual(result["status"], "PARTIAL")
        self.assertEqual(result["issuers"][0]["status"], "HISTORY_TRUNCATED")

    def test_historical_page_recovery(self):
        name = f"CIK{CIK}-submissions-001.json"
        self.transport.data["filings"]["files"] = [{"name": name, "filingFrom": "2025-01-01", "filingTo": "2026-09-02"}]
        old = submissions(["0001234567-26-000002"])["filings"]["recent"]
        old["filingDate"] = ["2026-09-02"]
        self.transport.pages[f"https://data.sec.gov/submissions/{name}"] = old
        report = self.collect()
        self.assertEqual(report["documentsCollected"], 2)
        self.assertEqual(report["issuers"][0]["historicalFilesRead"], 1)

    def test_malformed_metadata_keeps_raw_not_false_complete(self):
        self.transport.data["filings"]["recent"]["form"] = []
        report = self.collect()
        self.assertEqual(report["status"], "PARTIAL")
        self.assertEqual(self.store.db.execute("SELECT COUNT(*) FROM raw").fetchone()[0], 1)
        self.assertEqual(c.export_events(self.store)["events"], [])

    def test_changed_accession_metadata_cannot_rewrite_original(self):
        self.collect()
        self.transport.data["filings"]["recent"]["acceptanceDateTime"] = ["2026-09-08T12:00:00Z"]
        report = self.collect()
        self.assertEqual(report["status"], "PARTIAL")
        self.assertEqual(c.export_events(self.store)["events"][0]["acceptedAt"], "2026-09-08T14:00:00Z")

    def test_acceptance_timezone_not_guessed(self):
        self.transport.data["filings"]["recent"]["acceptanceDateTime"] = ["2026-09-08T14:00:00"]
        self.collect()
        event = c.export_events(self.store)["events"][0]
        self.assertIsNone(event["acceptedAt"])
        self.assertIn("ACCEPTANCE_TIMESTAMP_HAS_UNKNOWN_TIMEZONE_OR_FORMAT", event["warnings"])

    def test_429_stops_cycle_without_retry(self):
        self.transport.doc_status = 429
        result = self.collect()
        self.assertEqual(result["requests"], 2)
        self.assertEqual(result["status"], "PARTIAL")

    def test_capacity_failure_is_visible(self):
        self.store.max_bytes = 1
        with self.assertRaisesRegex(c.LimitError, "storage limit"):
            self.collect()

    def test_per_database_lock_refuses_second_collector(self):
        with c.collector_lock(self.path):
            with self.assertRaisesRegex(c.LimitError, "another collector"):
                self.collect()


class BoundaryTests(unittest.TestCase):
    def test_url_scope_and_xsl_raw(self):
        self.assertEqual(c.document_url(CIK, ACC, "xslF345X05/ownership.xml"), f"https://www.sec.gov/Archives/edgar/data/{int(CIK)}/000123456726000001/ownership.xml")
        for item in ("../evil", "foo/../../evil.xml", "https://evil.test/f.xml", "foo%2f.xml"):
            with self.subTest(item=item), self.assertRaises(ValueError):
                c.document_url(CIK, ACC, item)
        for url in ("https://evil.test/", "https://www.sec.gov@evil.test/a", "http://data.sec.gov/submissions/CIK0001234567.json", "https://data.sec.gov/submissions/CIK0001234567.json?query=1", "https://data.sec.gov/submissions/%2e%2e/foo"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                c.check_url(url)

    def test_redirect_refused(self):
        with self.assertRaisesRegex(ValueError, "redirect"):
            c.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://evil.test")

    def test_declared_contact_required(self):
        for ua in ("", "catalyst", "Catalyst developer@example.com", "bad\ncontact@real-domain.test"):
            with self.subTest(ua=ua), self.assertRaises(ValueError):
                c.validate_config(config(userAgent=ua))
        self.assertEqual(c.validate_config(config(userAgent="Catalyst operator@my-real-company.test"))["requestsPerSecond"], 5)

    def test_body_limit_is_never_retained_as_complete(self):
        cfg = config(maxBodyBytes=1024)
        transport = lambda *_: (200, {}, b"a" * 1025)
        client = c.SecClient(cfg, transport, Immediate())
        with self.assertRaisesRegex(c.LimitError, "body exceeds"):
            client.get(f"https://data.sec.gov/submissions/CIK{CIK}.json")

    def test_shared_limiter_spacing(self):
        limiter = c.RateLimiter()
        now = [0.0]
        def sleep(seconds):
            now[0] += seconds
        limiter.wait(10, lambda: now[0], sleep)
        limiter.wait(10, lambda: now[0], sleep)
        self.assertGreaterEqual(now[0], 0.101)
        limiter.wait(5, lambda: now[0], sleep)
        self.assertGreaterEqual(now[0], 0.202)

    def test_configuration_rejects_ambiguous_mapping(self):
        cfg = config()
        cfg["bindings"].append(copy.deepcopy(cfg["bindings"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            c.validate_config(cfg, False)


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        c.demo(self.temp.name)
        self.events = c.load_json(Path(self.temp.name) / "events.json")
        self.observations = c.load_json(Path(self.temp.name) / "observations.json")

    def tearDown(self):
        self.temp.cleanup()

    def result(self):
        return c.analyze(self.events, self.observations)["results"][0]

    def test_observed_response_uses_quote_units(self):
        result = self.result()
        self.assertEqual(result["localPriceChangePct"], "5.00")
        self.assertEqual(result["quoteTokenAddress"], STOCK)
        self.assertEqual(result["status"], "OBSERVED_LOCAL_PRICE_CHANGE")

    def test_missing_baseline_not_zero_return(self):
        self.observations["observations"].pop(0)
        result = self.result()
        self.assertEqual(result["status"], "INSUFFICIENT_DATA")
        self.assertIsNone(result["localPriceChangePct"])

    def test_late_backfilled_baseline_not_available_at_event(self):
        self.observations["observations"][0]["observedAt"] = "2026-09-08T14:00:03Z"
        self.assertIn("NO_BASELINE_KNOWN_BEFORE_EVENT", self.result()["reasons"])

    def test_orphaned_outcome_removed(self):
        self.observations["observations"][1]["canonical"] = False
        self.assertIn("NO_TIMELY_POST_EVENT_OBSERVATION", self.result()["reasons"])

    def test_canonical_conflicts_refused(self):
        conflicting = copy.deepcopy(self.observations["observations"][1])
        conflicting["blockHash"] = "0x" + "ff" * 32
        self.observations["observations"].append(conflicting)
        with self.assertRaisesRegex(ValueError, "conflicting canonical"):
            self.result()

    def test_quote_unit_change_not_comparable(self):
        self.observations["observations"][1]["priceBasis"] = "USD"
        self.assertIn("PRICE_UNITS_OR_ORIENTATION_CHANGED", self.result()["reasons"])

    def test_retrospective_mapping_cannot_create_prospective_result(self):
        self.events["events"][0]["associations"][0]["pools"][0]["mappingKnownAt"] = "2026-09-09T00:00:00Z"
        self.assertIn("MAPPING_NOT_KNOWN_AT_FIRST_OBSERVATION", self.result()["reasons"])

    def test_incomplete_interval_withholds_change(self):
        self.observations["coverage"][0]["canonicalComplete"] = False
        self.assertIn("CANONICAL_INTERVAL_COVERAGE_UNAVAILABLE", self.result()["reasons"])
        self.assertIsNone(self.result()["localPriceChangePct"])

    def test_wrong_chain_not_silently_accepted(self):
        self.observations["observations"][0]["chainId"] = 1
        with self.assertRaisesRegex(ValueError, "chain 4663"):
            self.result()

    def test_prices_must_be_finite_strings(self):
        for price in ("NaN", "Infinity", "-1", "0", "1e10000", 1.0):
            with self.subTest(price=price):
                self.observations["observations"][0]["price"] = price
                with self.assertRaises(ValueError):
                    self.result()

    def test_same_event_late_outcome_is_not_fast_observation(self):
        self.observations["observations"][1]["observedAt"] = "2026-09-08T15:00:00Z"
        self.assertIn("NO_TIMELY_POST_EVENT_OBSERVATION", self.result()["reasons"])

    def test_late_document_details_shift_anchor_and_withhold_early_response(self):
        self.events["events"][0]["detailsAvailableAt"] = "2026-09-08T14:05:02Z"
        result = self.result()
        self.assertEqual(result["anchorAt"], "2026-09-08T14:05:02Z")
        self.assertEqual(result["discoveryToDetailsSeconds"], 300)
        self.assertIn("NO_TIMELY_POST_EVENT_OBSERVATION", result["reasons"])

    def test_unknown_detail_availability_withholds_actionability(self):
        self.events["events"][0].pop("detailsAvailableAt")
        self.assertIn("DETAIL_AVAILABILITY_TIME_UNAVAILABLE", self.result()["reasons"])

    def test_cli_demo_complete_and_idempotence_refuses_overwrite(self):
        process = subprocess.run([sys.executable, str(Path(c.__file__)), "demo", "--out", self.temp.name], capture_output=True, text=True)
        self.assertEqual(process.returncode, 2)
        self.assertIn("fresh output", process.stderr)


if __name__ == "__main__":
    unittest.main()
