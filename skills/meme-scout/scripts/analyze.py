#!/usr/bin/env python3
"""Deterministic analysis of supplied post evidence; no network or authentication."""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import urlsplit

MAX_BYTES = 5_000_000
KINDS = {"observed", "synthetic", "unknown"}
BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def need(condition, message):
    if not condition:
        raise ValueError(message)


def obj(value, required, optional=()):
    need(type(value) is dict, "expected object")
    need(set(required) <= value.keys(), "missing fields: " + str(set(required) - value.keys()))
    need(value.keys() <= set(required) | set(optional), "unexpected object fields")


def string(value, maximum=1000):
    need(isinstance(value, str) and 0 < len(value) <= maximum and value.strip() == value,
         "expected nonblank bounded string without outer whitespace")
    need(not any(ord(c) < 32 and c not in "\n\t" for c in value), "control character")
    return value


def choice(value, allowed):
    need(isinstance(value, str) and value in allowed, "invalid classification")


def sequence(value, maximum):
    need(type(value) is list and len(value) <= maximum, "expected bounded array")


def timestamp(value):
    string(value, 40)
    need(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)", value)),
         "timestamp must include seconds and explicit timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    need(parsed.utcoffset() is not None, "timezone required")
    return parsed.astimezone(timezone.utc)


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def url(value):
    string(value, 2000)
    parsed = urlsplit(value)
    need(parsed.scheme in {"https", "http"} and bool(parsed.hostname)
         and not parsed.username and not parsed.password and not any(c.isspace() for c in value),
         "expected public source URL without embedded credentials")


def token_id(chain, address):
    string(chain, 64)
    string(address, 64)
    if re.fullmatch(r"eip155:[1-9][0-9]{0,19}", chain):
        need(bool(re.fullmatch(r"0x[0-9a-fA-F]{40}", address)), "invalid EVM address")
        address = address.lower()
    else:
        need(bool(re.fullmatch(r"solana:[1-9A-HJ-NP-Za-km-z]{1,32}", chain)), "unsupported chain")
        need(all(c in BASE58 for c in address), "invalid base58 address")
        number = 0
        for character in address:
            number = number * 58 + BASE58.index(character)
        length = len(address) - len(address.lstrip("1")) + (number.bit_length() + 7) // 8
        need(length == 32, "Solana address must decode to 32 bytes")
    return chain + "/" + address


def provenance(declared, individual):
    if "synthetic" in (declared, individual):
        return "synthetic"
    return "unknown" if "unknown" in (declared, individual) else "observed"


def pairs(items):
    result = {}
    for key, value in items:
        need(key not in result, "duplicate JSON key: " + key)
        result[key] = value
    return result


def parse(raw):
    need(len(raw) <= MAX_BYTES, "input exceeds 5 MB")
    def bad_constant(value):
        raise ValueError("non-finite JSON number: " + value)
    try:
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=bad_constant)
    except (UnicodeError, RecursionError) as exc:
        raise ValueError("invalid or excessively nested UTF-8 JSON") from exc
    validate(data)
    return data


def validate(data):
    obj(data, {"schema_version", "source_kind", "window_start", "cutoff", "narrative",
               "coverage", "tokens", "observations"})
    need(data["schema_version"] == "meme-scout.input.v1", "unsupported schema_version")
    choice(data["source_kind"], KINDS)
    start, cutoff = timestamp(data["window_start"]), timestamp(data["cutoff"])
    need(start <= cutoff, "window_start after cutoff")
    obj(data["narrative"], {"id", "label"})
    for value in data["narrative"].values():
        string(value, 300)
    coverage = data["coverage"]
    obj(coverage, {"queries", "channels", "limitations", "selection_notes"})
    for key in ("queries", "channels", "limitations"):
        sequence(coverage[key], 100)
        for value in coverage[key]:
            string(value, 2000)
    string(coverage["selection_notes"], 5000)
    sequence(data["tokens"], 100)
    identifiers = set()
    for token in data["tokens"]:
        obj(token, {"chain", "address", "available_at", "identity_status", "evidence"})
        identifier = token_id(token["chain"], token["address"])
        need(identifier not in identifiers, "duplicate canonical token identity")
        identifiers.add(identifier)
        timestamp(token["available_at"])
        choice(token["identity_status"], {"verified", "ambiguous", "unverified"})
        sequence(token["evidence"], 100)
        for evidence in token["evidence"]:
            obj(evidence, {"url", "available_at", "source_kind", "role", "claim"})
            url(evidence["url"])
            timestamp(evidence["available_at"])
            choice(evidence["source_kind"], KINDS)
            choice(evidence["role"], {"primary", "secondary"})
            string(evidence["claim"], 2000)
    sequence(data["observations"], 3000)
    seen = set()
    for post in data["observations"]:
        obj(post, {"id", "platform", "author_id", "event_time", "available_at", "url", "text",
                   "source_kind", "kind", "narrative_match", "sponsorship", "community"},
            {"coordination_group", "coordination_basis", "token_ids"})
        for key in ("id", "platform", "author_id"):
            string(post[key], 200)
        need(post["id"] not in seen, "duplicate observation id")
        seen.add(post["id"])
        need(timestamp(post["event_time"]) <= timestamp(post["available_at"]),
             "observation cannot be available before its event")
        url(post["url"])
        string(post["text"], 6000)
        choice(post["source_kind"], KINDS)
        choice(post["kind"], {"original", "repost", "quote", "reply", "unknown"})
        choice(post["narrative_match"], {"confirmed", "uncertain"})
        choice(post["sponsorship"], {"paid", "unpaid", "unknown"})
        community = post["community"]
        obj(community, {"label", "confidence", "basis"})
        choice(community["confidence"], {"documented", "inferred", "unknown"})
        if community["label"] is not None:
            string(community["label"], 200)
        need(community["confidence"] == "unknown" or community["label"] is not None,
             "assigned community requires label")
        string(community["basis"], 2000)
        if "coordination_group" in post:
            string(post["coordination_group"], 200)
            need("coordination_basis" in post, "coordination group requires basis")
        if "coordination_basis" in post:
            need("coordination_group" in post, "coordination basis requires group")
            string(post["coordination_basis"], 2000)
        sequence(post.get("token_ids", []), 100)
        need(all(isinstance(item, str) and item in identifiers for item in post.get("token_ids", [])),
             "unknown or noncanonical token reference")
        need(len(set(post.get("token_ids", []))) == len(post.get("token_ids", [])), "duplicate token reference")


def fingerprint(text):
    normalized = unicodedata.normalize("NFKC", text).casefold()
    normalized = re.sub(r"https?://\S+", "", normalized)
    return " ".join(normalized.split())


def author(post):
    return (post["platform"], post["author_id"])


def counts(values):
    return dict(sorted(Counter(values).items()))


def analyze(raw):
    data = parse(raw)
    cutoff, start = timestamp(data["cutoff"]), timestamp(data["window_start"])
    retained, exclusions = [], []
    for post in data["observations"]:
        reasons = []
        if timestamp(post["event_time"]) < start:
            reasons.append("event_before_window")
        if timestamp(post["event_time"]) > cutoff:
            reasons.append("event_after_cutoff")
        if timestamp(post["available_at"]) > cutoff:
            reasons.append("available_after_cutoff")
        if reasons:
            exclusions.append({"scope": "observation", "id": post["id"], "reasons": reasons})
        else:
            retained.append(dict(post, effective_source_kind=provenance(data["source_kind"], post["source_kind"])))
    retained.sort(key=lambda p: (timestamp(p["event_time"]), p["id"]))
    tokens = []
    for token in data["tokens"]:
        identifier = token_id(token["chain"], token["address"])
        if timestamp(token["available_at"]) > cutoff:
            exclusions.append({"scope": "token", "id": identifier, "reasons": ["available_after_cutoff"]})
            continue
        evidence = []
        for index, item in enumerate(token["evidence"]):
            if timestamp(item["available_at"]) > cutoff:
                exclusions.append({"scope": "identity_evidence", "id": identifier + "#" + str(index),
                                   "reasons": ["available_after_cutoff"]})
            else:
                evidence.append(dict(item, effective_source_kind=provenance(data["source_kind"], item["source_kind"])))
        primary = any(e["role"] == "primary" and e["effective_source_kind"] == "observed" for e in evidence)
        status = "resolved_supplied" if token["identity_status"] == "verified" and primary else "unresolved"
        tokens.append({"token_id": identifier, "chain": token["chain"], "address": identifier.split("/", 1)[1],
                       "available_at": iso(timestamp(token["available_at"])), "declared_status": token["identity_status"],
                       "status": status, "evidence": evidence})
    tokens.sort(key=lambda t: t["token_id"])
    eligible_tokens = {t["token_id"] for t in tokens}
    for post in retained:
        links = post.get("token_ids", [])
        removed = [item for item in links if item not in eligible_tokens]
        if removed:
            exclusions.append({"scope": "post_token_association", "id": post["id"],
                               "reasons": ["token_unavailable_at_cutoff"], "count": len(removed)})
        post["token_ids"] = [item for item in links if item in eligible_tokens]
    grouped = defaultdict(list)
    for post in retained:
        key = fingerprint(post["text"])
        if key and post["kind"] == "original" and post["narrative_match"] == "confirmed":
            grouped[(post["effective_source_kind"], key)].append(post)
    copies, copied_ids = [], set()
    for (source, key), posts in sorted(grouped.items()):
        if len({author(p) for p in posts}) > 1:
            ids = sorted(p["id"] for p in posts)
            copies.append({"fingerprint_sha256": hashlib.sha256(key.encode()).hexdigest(),
                           "source_kind": source, "observation_ids": ids})
            copied_ids.update(ids)
    candidates, classifications = [], []
    for post in retained:
        reasons = []
        if post["kind"] != "original":
            reasons.append("kind_" + post["kind"])
        if post["narrative_match"] != "confirmed":
            reasons.append("uncertain_narrative_match")
        if post["sponsorship"] == "paid":
            reasons.append("paid_promotion")
        if "coordination_group" in post:
            reasons.append("supplied_coordination_group")
        if post["id"] in copied_ids:
            reasons.append("normalized_text_shared_across_original_authors")
        if post["effective_source_kind"] != "observed":
            reasons.append("non_observed_source")
        if not reasons:
            candidates.append(post)
        classifications.append({"id": post["id"], "observed_original_candidate": not reasons,
                                "exclusion_reasons": reasons})
    communities = defaultdict(list)
    for post in candidates:
        if post["community"]["confidence"] == "documented":
            communities[post["community"]["label"]].append(post)
    by_community = [{"label": label, "distinct_author_count": len({author(p) for p in posts}),
                     "observation_ids": [p["id"] for p in posts],
                     "first_observed_event_time": iso(timestamp(posts[0]["event_time"]))}
                    for label, posts in sorted(communities.items())]
    digest = hashlib.sha256(raw).hexdigest()
    effective = data["source_kind"]
    for post in retained:
        effective = provenance(effective, post["effective_source_kind"])
    for token in tokens:
        for item in token["evidence"]:
            effective = provenance(effective, item["effective_source_kind"])
    summary = {"input_observations": len(data["observations"]), "retained_observations": len(retained),
               "retained_by_source": counts(p["effective_source_kind"] for p in retained),
               "retained_by_kind": counts(p["kind"] for p in retained),
               "retained_by_sponsorship": counts(p["sponsorship"] for p in retained),
               "observed_original_candidate_posts": len(candidates),
               "distinct_author_original_candidates": len({author(p) for p in candidates}),
               "candidates_with_unknown_sponsorship": sum(p["sponsorship"] == "unknown" for p in candidates),
               "documented_community_labels": len(by_community),
               "first_observed_candidate_event_time": iso(timestamp(candidates[0]["event_time"])) if candidates else None,
               "candidate_posts_by_utc_day": counts(timestamp(p["event_time"]).date().isoformat() for p in candidates)}
    handoff = {"schema_version": "meme-scout.handoff.v1", "source_report_schema": "meme-scout.report.v1",
               "source_report_input_sha256": digest, "source_kind": effective,
               "window_start": iso(start), "cutoff": iso(cutoff), "narrative": data["narrative"],
               "tokens": tokens, "retained_observation_ids": [p["id"] for p in retained]}
    return {"schema_version": "meme-scout.report.v1", "analyzer_version": "1.0.0", "input_sha256": digest,
            "source_kind": effective, "input_source_kind": data["source_kind"], "window_start": iso(start),
            "cutoff": iso(cutoff), "narrative": data["narrative"], "coverage": data["coverage"],
            "summary": summary, "communities": by_community, "normalized_copy_groups": copies,
            "classifications": classifications, "exclusions": sorted(exclusions, key=lambda e: (e["scope"], e["id"])),
            "retained_observations": retained, "tokens": tokens, "handoff": handoff,
            "limitations": ["Supplied evidence is not independently authenticated; input hashes do not prove truth.",
                            "Counts describe this incomplete selected sample; distinct accounts do not prove independence.",
                            "Only normalized exact text copies are detected; semantic, image, and undisclosed campaigns can be missed.",
                            "Original-candidate classification permits unknown sponsorship and is not a causal or trading signal."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        with args.input.open("rb") as handle:
            raw = handle.read(MAX_BYTES + 1)
        report = analyze(raw)
        output = (json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
        with args.out.open("xb") as handle:
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        print(str(args.out))
    except (ValueError, OSError, OverflowError) as exc:
        print("error: " + str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
