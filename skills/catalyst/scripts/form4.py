"""Bounded, read-only SEC ownership XML extraction using Python's standard library.

This is evidence extraction, not SEC XSD validation or transaction intent inference.
All rows and XML fields survive; no holdings, options or amendments are netted.
Numeric products are reported-value products, never asserted execution cash flows.
"""

from __future__ import annotations

from collections import Counter
from datetime import date
from decimal import Decimal, localcontext
import hashlib
import re
import xml.etree.ElementTree as ET


MAX_XML_BYTES = 4 * 1024 * 1024
MAX_XML_DEPTH = 96
MAX_XML_NODES = 100_000
MAX_DECIMAL_CHARS = 1024
NOTIONAL_MEANING = "REPORTED_VALUES_PRODUCT_NOT_CASH_EXECUTED"
CODE_CLASSES = {
    "P": "OPEN_MARKET_OR_PRIVATE_PURCHASE",
    "S": "OPEN_MARKET_OR_PRIVATE_SALE",
    "F": "TAX_OR_EXERCISE_WITHHOLDING",
    "A": "GRANT_OR_AWARD",
    "M": "EXERCISE_OR_CONVERSION",
}


class _BoundedTreeBuilder(ET.TreeBuilder):
    """Reject DTDs at the XML parser layer, including UTF-16 input."""

    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nodes = 0

    def doctype(self, name, pubid, system):
        raise ValueError("DTD and custom entity declarations are prohibited")

    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > MAX_XML_DEPTH:
            raise ValueError("XML nesting exceeds parser limit")
        if self.nodes > MAX_XML_NODES:
            raise ValueError("XML node count exceeds parser limit")
        return super().start(tag, attrs)

    def end(self, tag):
        result = super().end(tag)
        self.depth -= 1
        return result


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(node, tag):
    return [] if node is None else [n for n in node if _local(n.tag) == tag]


def _find(node, path):
    """An ambiguous scalar is a malformed input, never silently the first value."""
    for tag in path.split("/"):
        found = _children(node, tag)
        if len(found) > 1:
            raise ValueError(f"Duplicate scalar/container element in {path}: {tag}")
        if not found:
            return None
        node = found[0]
    return node


def _value(node, path):
    found = _find(node, path)
    if found is None:
        return None
    value = _find(found, "value")
    text = value.text if value is not None else found.text
    return text.strip() if text and text.strip() else None


def _warn(warnings, code, path, detail):
    warnings.append({"code": code, "path": path, "detail": detail})


def _decimal_string(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if value == 0 else text


def _number(node, path, warnings):
    text = _value(node, path)
    if text is None:
        if _find(node, path) is not None:
            _warn(warnings, "NUMERIC_VALUE_UNAVAILABLE", path,
                  "No numeric value was supplied; inspect retained XML and footnotes.")
        return None
    if (len(text) > MAX_DECIMAL_CHARS
            or not re.fullmatch(r"\+?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", text)):
        _warn(warnings, "INVALID_NONNEGATIVE_DECIMAL", path,
              "Expected a finite nonnegative decimal; original text is retained in XML.")
        return None
    return _decimal_string(Decimal(text))


def _date(node, path, warnings):
    text = _value(node, path)
    if text is None:
        return None
    try:
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", text):
            raise ValueError()
        return date.fromisoformat(text).isoformat()
    except ValueError:
        _warn(warnings, "INVALID_DATE", path,
              "Expected a valid YYYY-MM-DD date; original text is retained in XML.")
        return None


def _bool(node, path, warnings):
    text = _value(node, path)
    if text is None:
        return None
    if text.lower() in {"1", "true"}:
        return True
    if text.lower() in {"0", "false"}:
        return False
    _warn(warnings, "INVALID_BOOLEAN", path,
          "Checkbox value is not recognized; it has not been treated as false.")
    return None


def _cik(text):
    if text is None or not re.fullmatch(r"[0-9]{1,10}", text) or int(text) == 0:
        raise ValueError("CIK must be a positive identifier of 1 to 10 decimal digits")
    return text.zfill(10)


def _footnote_refs(node):
    """Return relative field paths, indexing repeated elements without losing them."""
    refs = {}

    def walk(current, path):
        ids = [child.get("id") for child in current if _local(child.tag) == "footnoteId"]
        if ids:
            refs[path or "."] = ids
        children = [child for child in current if _local(child.tag) != "footnoteId"]
        totals = Counter(_local(child.tag) for child in children)
        indexes = Counter()
        for child in children:
            tag = _local(child.tag)
            index = indexes[tag]
            indexes[tag] += 1
            part = f"{tag}[{index}]" if totals[tag] > 1 else tag
            walk(child, f"{path}/{part}" if path else part)

    walk(node, "")
    return refs


def _check_refs(refs, known_ids, warnings):
    for path, ids in refs.items():
        for ident in ids:
            if not ident or ident not in known_ids:
                _warn(warnings, "UNRESOLVED_FOOTNOTE", path,
                      f"Footnote reference {ident!r} has no unambiguous retained definition.")


def _row(node, table, record_type, index, known_footnotes):
    warnings = []
    code = _value(node, "transactionCoding/transactionCode")
    shares = _number(node, "transactionAmounts/transactionShares", warnings)
    price = _number(node, "transactionAmounts/transactionPricePerShare", warnings)
    notional = None
    if shares is not None and price is not None and record_type == "transaction":
        left, right = Decimal(shares), Decimal(price)
        # Sufficient for the exact product, independently of ambient Decimal precision.
        with localcontext() as context:
            context.prec = len(left.as_tuple().digits) + len(right.as_tuple().digits) + 2
            notional = _decimal_string(left * right)
    refs = _footnote_refs(node)
    _check_refs(refs, known_footnotes, warnings)
    acquired = _value(node, "transactionAmounts/transactionAcquiredDisposedCode")
    direct = _value(node, "ownershipNature/directOrIndirectOwnership")
    if acquired is not None and acquired not in {"A", "D"}:
        _warn(warnings, "UNRECOGNIZED_ACQUIRED_DISPOSED", "transactionAmounts/transactionAcquiredDisposedCode",
              "Acquired/disposed code is retained without assigning a direction.")
    if direct is not None and direct not in {"D", "I"}:
        _warn(warnings, "UNRECOGNIZED_OWNERSHIP_FORM", "ownershipNature/directOrIndirectOwnership",
              "Ownership code is retained without assigning direct or indirect ownership.")
    if record_type == "transaction" and code is None:
        _warn(warnings, "MISSING_TRANSACTION_CODE", "transactionCoding/transactionCode",
              "A transaction row has no transaction code.")
    if (code == "P" and acquired == "D") or (code == "S" and acquired == "A"):
        _warn(warnings, "CODE_DIRECTION_CONFLICT", "transactionAmounts/transactionAcquiredDisposedCode",
              "Reported code and acquired/disposed flag conflict; no trade direction is inferred.")
    return {
        "rowId": f"{table}:{record_type}:{index}",
        "table": table,
        "recordType": record_type,
        "securityTitle": _value(node, "securityTitle"),
        "transactionDate": _date(node, "transactionDate", warnings),
        "deemedExecutionDate": _date(node, "deemedExecutionDate", warnings),
        "code": code,
        "classification": CODE_CLASSES.get(code, "OTHER_CODE") if record_type == "transaction" else "HOLDING",
        "acquiredDisposed": acquired,
        "shares": shares,
        "price": price,
        "reportedNotional": notional,
        "reportedNotionalMeaning": NOTIONAL_MEANING if notional is not None else None,
        "reportedNotionalFootnoted": any(
            path.startswith("transactionAmounts/transactionShares")
            or path.startswith("transactionAmounts/transactionPricePerShare") for path in refs
        ),
        "postshares": _number(node, "postTransactionAmounts/sharesOwnedFollowingTransaction", warnings),
        "directIndirect": direct,
        "indirectNature": _value(node, "ownershipNature/natureOfOwnership"),
        "underlyingSecurityTitle": _value(node, "underlyingSecurity/underlyingSecurityTitle"),
        "underlyingShares": _number(node, "underlyingSecurity/underlyingSecurityShares", warnings),
        "exercisePrice": _number(node, "conversionOrExercisePrice", warnings),
        "exerciseDate": _date(node, "exerciseDate", warnings),
        "expiry": _date(node, "expirationDate", warnings),
        "footnoteReferences": refs,
        "warnings": warnings,
        "rawXml": ET.tostring(node, encoding="unicode"),
    }


def parse_form4(raw: bytes) -> dict:
    """Parse one original ownership XML document (not SEC stylesheet-rendered HTML).

    Raises ValueError for unsafe/malformed input, ambiguous identity, or non-Form4.
    Missing/invalid optional numeric and date fields become None with warnings.
    ``rawXml`` is reserialized XML; ``rawSha256`` identifies the original bytes.
    The collector must retain those original bytes for exact provenance.
    """
    if not isinstance(raw, bytes):
        raise ValueError("Form 4 parser requires bytes")
    if not raw or len(raw) > MAX_XML_BYTES:
        raise ValueError("Form 4 XML must be nonempty and at most 4 MiB")
    # Fast rejection, with parser-level doctype rejection covering other encodings.
    if re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", raw, re.IGNORECASE):
        raise ValueError("DTD and custom entity declarations are prohibited")
    try:
        root = ET.fromstring(raw, parser=ET.XMLParser(target=_BoundedTreeBuilder()))
    except ET.ParseError as exc:
        raise ValueError(f"Malformed ownership XML: {exc}") from exc
    if _local(root.tag) != "ownershipDocument":
        raise ValueError("Expected an ownershipDocument XML root")
    document_type = _value(root, "documentType")
    if document_type not in {"4", "4/A"}:
        raise ValueError("Expected documentType 4 or 4/A")
    issuer_node = _find(root, "issuer")
    issuer_cik = _cik(_value(issuer_node, "issuerCik"))
    warnings = []
    footnotes = []
    for container in _children(root, "footnotes"):
        for node in _children(container, "footnote"):
            footnotes.append({"id": node.get("id"), "text": "".join(node.itertext()).strip(),
                              "rawXml": ET.tostring(node, encoding="unicode")})
    footnote_counts = Counter(note["id"] for note in footnotes)
    known_footnotes = {ident for ident, count in footnote_counts.items() if ident and count == 1}
    for ident, count in footnote_counts.items():
        if not ident or count > 1:
            _warn(warnings, "AMBIGUOUS_FOOTNOTE_DEFINITION", "footnotes",
                  f"Footnote ID {ident!r} occurs {count} times; definitions remain separate.")
    owners = []
    for index, owner in enumerate(_children(root, "reportingOwner")):
        owner_cik_raw = _value(owner, "reportingOwnerId/rptOwnerCik")
        try:
            owner_cik = _cik(owner_cik_raw)
        except ValueError:
            owner_cik = None
            _warn(warnings, "INVALID_REPORTING_OWNER_CIK", f"reportingOwner[{index}]/reportingOwnerId/rptOwnerCik",
                  "Reporting owner CIK is unavailable; original data is retained.")
        relationship = _find(owner, "reportingOwnerRelationship")
        owner_warnings = []
        owners.append({
            "cik": owner_cik,
            "name": _value(owner, "reportingOwnerId/rptOwnerName"),
            "relationship": {
                "isDirector": _bool(relationship, "isDirector", owner_warnings),
                "isOfficer": _bool(relationship, "isOfficer", owner_warnings),
                "isTenPercentOwner": _bool(relationship, "isTenPercentOwner", owner_warnings),
                "isOther": _bool(relationship, "isOther", owner_warnings),
                "officerTitle": _value(relationship, "officerTitle"),
                "otherText": _value(relationship, "otherText"),
            },
            "warnings": owner_warnings,
            "rawXml": ET.tostring(owner, encoding="unicode"),
        })
    if not owners:
        _warn(warnings, "NO_REPORTING_OWNERS", "reportingOwner", "No reporting-owner records were present.")
    rows = []
    indexes = Counter()
    for container in root:
        container_name = _local(container.tag)
        if container_name not in {"nonDerivativeTable", "derivativeTable"}:
            continue
        table = "nonDerivative" if container_name == "nonDerivativeTable" else "derivative"
        for node in container:
            name = _local(node.tag)
            if name == table + "Transaction":
                record_type = "transaction"
            elif name == table + "Holding":
                record_type = "holding"
            else:
                _warn(warnings, "UNKNOWN_TABLE_RECORD", container_name + "/" + name,
                      "Unrecognized table record remains in raw XML and is not interpreted as a transaction.")
                continue
            key = (table, record_type)
            rows.append(_row(node, table, record_type, indexes[key], known_footnotes))
            indexes[key] += 1
    refs = _footnote_refs(root)
    _check_refs(refs, known_footnotes, warnings)
    period = _date(root, "periodOfReport", warnings)
    original_date = _date(root, "dateOfOriginalSubmission", warnings)
    aff = _bool(root, "aff10b5One", warnings)
    return {
        "schemaVersion": "CatalystForm4@1",
        "documentType": document_type,
        "isAmendment": document_type == "4/A",
        "dateOfOriginalSubmission": original_date,
        "periodOfReport": period,
        "aff10b5One": aff,
        "aff10b5OneScope": "DOCUMENT_ONLY_NOT_ROW_ATTRIBUTION",
        "issuer": {"cik": issuer_cik, "name": _value(issuer_node, "issuerName"),
                   "tradingSymbol": _value(issuer_node, "issuerTradingSymbol"),
                   "foreignTradingSymbol": _value(issuer_node, "issuerForeignTradingSymbol")},
        "owners": owners,
        "rows": rows,
        "footnotes": footnotes,
        "footnoteReferences": refs,
        "warnings": warnings,
        "rawXml": ET.tostring(root, encoding="unicode"),
        "rawSha256": hashlib.sha256(raw).hexdigest(),
    }
