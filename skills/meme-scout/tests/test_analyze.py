import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("analyze", ROOT / "scripts/analyze.py")
analyzer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(analyzer)


class AnalyzerTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / "examples/synthetic-observations.json").read_text())

    def observed(self):
        self.data["source_kind"] = "observed"
        for post in self.data["observations"]:
            post["source_kind"] = "observed"
        for token in self.data["tokens"]:
            for evidence in token["evidence"]:
                evidence["source_kind"] = "observed"

    def run_data(self):
        return analyzer.analyze(json.dumps(self.data).encode())

    def test_synthetic_never_becomes_observed_adoption_or_resolved_token(self):
        report = self.run_data()
        self.assertEqual(report["source_kind"], "synthetic")
        self.assertEqual(report["summary"]["observed_original_candidate_posts"], 0)
        self.assertEqual(report["tokens"][0]["status"], "unresolved")
        self.assertEqual(report["summary"]["retained_by_source"], {"synthetic": 5})

    def test_copies_paid_campaign_and_repost_are_separated(self):
        self.observed()
        report = self.run_data()
        self.assertEqual(report["summary"]["distinct_author_original_candidates"], 1)
        self.assertEqual(report["summary"]["candidates_with_unknown_sponsorship"], 1)
        self.assertEqual(report["normalized_copy_groups"][0]["observation_ids"], ["example:2", "example:3"])
        classified = {p["id"]: p for p in report["classifications"]}
        self.assertTrue(classified["example:1"]["observed_original_candidate"])
        self.assertEqual(classified["example:5"]["exclusion_reasons"], ["paid_promotion", "supplied_coordination_group"])
        self.assertEqual(report["communities"][0]["label"], "illustrators")

    def test_later_discovery_cannot_change_first_observed_or_copy_groups(self):
        self.observed()
        self.data["observations"][-1]["text"] = self.data["observations"][0]["text"]
        report = self.run_data()
        self.assertEqual(report["summary"]["first_observed_candidate_event_time"], "2026-09-01T10:00:00Z")
        self.assertEqual(report["summary"]["distinct_author_original_candidates"], 1)
        self.assertNotIn("example:6", report["handoff"]["retained_observation_ids"])
        self.assertEqual(report["exclusions"][0]["reasons"], ["available_after_cutoff"])

    def test_all_temporal_exclusion_reasons_retained(self):
        self.data["observations"][0]["event_time"] = "2026-09-04T00:00:00Z"
        self.data["observations"][0]["available_at"] = "2026-09-05T00:00:00Z"
        report = self.run_data()
        row = next(e for e in report["exclusions"] if e["id"] == "example:1")
        self.assertEqual(row["reasons"], ["event_after_cutoff", "available_after_cutoff"])

    def test_cutoff_inclusive_and_offsets_normalized(self):
        self.observed()
        post = self.data["observations"][0]
        post["event_time"] = post["available_at"] = "2026-09-03T01:00:00+01:00"
        report = self.run_data()
        self.assertEqual(report["summary"]["first_observed_candidate_event_time"], "2026-09-03T00:00:00Z")

    def test_same_author_posts_do_not_multiply_authors(self):
        self.observed()
        post = copy.deepcopy(self.data["observations"][0])
        post["id"] = "another-post"
        self.data["observations"].append(post)
        report = self.run_data()
        self.assertEqual(report["summary"]["observed_original_candidate_posts"], 2)
        self.assertEqual(report["summary"]["distinct_author_original_candidates"], 1)

    def test_synthetic_copy_cannot_suppress_observed_original(self):
        self.observed()
        post = self.data["observations"][1]
        post["text"] = self.data["observations"][0]["text"]
        post["source_kind"] = "synthetic"
        report = self.run_data()
        self.assertEqual(report["source_kind"], "synthetic")
        self.assertEqual(report["summary"]["distinct_author_original_candidates"], 2)

    def test_inferred_community_does_not_enter_documented_count(self):
        self.observed()
        self.data["observations"][0]["community"]["confidence"] = "inferred"
        self.assertEqual(self.run_data()["communities"], [])

    def test_future_token_and_association_removed_from_handoff(self):
        self.observed()
        self.data["tokens"][0]["available_at"] = "2026-09-04T00:00:00Z"
        report = self.run_data()
        self.assertEqual(report["handoff"]["tokens"], [])
        linked = next(p for p in report["retained_observations"] if p["id"] == "example:5")
        self.assertEqual(linked["token_ids"], [])
        self.assertTrue(any(e["scope"] == "post_token_association" for e in report["exclusions"]))

    def test_identity_requires_eligible_primary_observed_evidence(self):
        self.observed()
        self.assertEqual(self.run_data()["tokens"][0]["status"], "resolved_supplied")
        self.data["tokens"][0]["evidence"][0]["available_at"] = "2026-09-04T00:00:00Z"
        report = self.run_data()
        self.assertEqual(report["tokens"][0]["status"], "unresolved")
        self.assertEqual(report["tokens"][0]["evidence"], [])

    def test_competing_ambiguous_tokens_not_resolved(self):
        self.observed()
        other = copy.deepcopy(self.data["tokens"][0])
        other["address"] = "0x" + "12" * 20
        self.data["tokens"].append(other)
        for token in self.data["tokens"]:
            token["identity_status"] = "ambiguous"
        self.assertEqual([t["status"] for t in self.run_data()["tokens"]], ["unresolved", "unresolved"])

    def test_exact_chain_address_validation(self):
        self.assertEqual(analyzer.token_id("eip155:1", "0x" + "AB" * 20), "eip155:1/0x" + "ab" * 20)
        self.assertTrue(analyzer.token_id("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "1" * 32))
        for chain, address in [("eip155:01", "0x" + "ab" * 20), ("solana:main", "1" * 31), ("other:1", "abc")]:
            with self.subTest(chain=chain), self.assertRaises(ValueError):
                analyzer.token_id(chain, address)

    def test_duplicate_ids_and_tokens_rejected(self):
        self.data["observations"].append(copy.deepcopy(self.data["observations"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate observation"):
            self.run_data()
        self.data["observations"].pop()
        token = copy.deepcopy(self.data["tokens"][0])
        token["address"] = "0x" + token["address"][2:].upper()
        self.data["tokens"].append(token)
        with self.assertRaisesRegex(ValueError, "duplicate canonical"):
            self.run_data()

    def test_strict_json_size_and_schema_fail_closed(self):
        for raw in [b'{"a":1,"a":2}', b'{"a":NaN}', b"[1]", b" " * (analyzer.MAX_BYTES + 1)]:
            with self.subTest(raw=raw[:30]), self.assertRaises(ValueError):
                analyzer.analyze(raw)
        self.data["invented"] = True
        with self.assertRaises(ValueError):
            self.run_data()

    def test_event_cannot_be_available_earlier(self):
        self.data["observations"][0]["available_at"] = "2026-08-01T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "before its event"):
            self.run_data()

    def test_invalid_timezone_offsets_are_rejected_without_normalization(self):
        for offset in ["+00:99", "-01:60", "+24:00"]:
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                analyzer.timestamp("2026-09-03T00:00:00" + offset)

    def test_empty_sample_and_input_byte_hash(self):
        self.data["observations"] = []
        raw = json.dumps(self.data).encode()
        report = analyzer.analyze(raw)
        self.assertEqual(report, analyzer.analyze(raw))
        self.assertEqual(report["input_sha256"], hashlib.sha256(raw).hexdigest())
        self.assertIsNone(report["summary"]["first_observed_candidate_event_time"])

    def test_cli_is_deterministic_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "report.json"
            command = [sys.executable, str(ROOT / "scripts/analyze.py"), str(ROOT / "examples/synthetic-observations.json"), "--out", str(out)]
            first = subprocess.run(command, capture_output=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            original = out.read_bytes()
            second = subprocess.run(command, capture_output=True)
            self.assertEqual(second.returncode, 2)
            self.assertEqual(out.read_bytes(), original)
            another = Path(directory) / "report2.json"
            command[-1] = str(another)
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(another.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
