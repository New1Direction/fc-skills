"""Evidence-preservation, accounting and hostile-input tests for the Form 4 parser."""

from decimal import getcontext
import hashlib
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

from form4 import MAX_XML_BYTES, MAX_XML_DEPTH, parse_form4


FIXTURE = Path(__file__).resolve().parents[1] / "assets" / "form4-synthetic.xml"


class Form4Tests(unittest.TestCase):
    def setUp(self):
        self.raw = FIXTURE.read_bytes()

    def parse_changed(self, old, new):
        self.assertIn(old.encode(), self.raw)
        return parse_form4(self.raw.replace(old.encode(), new.encode(), 1))

    def test_preserves_distinct_transactions_holdings_and_joint_owners(self):
        parsed = parse_form4(self.raw)
        self.assertEqual(parsed["schemaVersion"], "CatalystForm4@1")
        self.assertEqual(parsed["issuer"]["cik"], "0000123456")
        self.assertEqual(len(parsed["owners"]), 2)
        self.assertEqual(len(parsed["rows"]), 7)
        self.assertEqual([row["classification"] for row in parsed["rows"]], [
            "OPEN_MARKET_OR_PRIVATE_PURCHASE", "OPEN_MARKET_OR_PRIVATE_SALE",
            "TAX_OR_EXERCISE_WITHHOLDING", "GRANT_OR_AWARD", "HOLDING",
            "EXERCISE_OR_CONVERSION", "HOLDING",
        ])
        self.assertEqual(len({row["rowId"] for row in parsed["rows"]}), 7)
        self.assertEqual(parsed["rows"][4]["rowId"], "nonDerivative:holding:0")
        self.assertEqual(parsed["rows"][5]["rowId"], "derivative:transaction:0")
        self.assertEqual(parsed["rows"][4]["postshares"], "2000")
        self.assertIsNone(parsed["rows"][4]["shares"])
        self.assertEqual(parsed["rows"][3]["price"], "0")

    def test_footnoted_product_is_exact_and_never_called_cash(self):
        row = parse_form4(self.raw)["rows"][0]
        self.assertEqual(row["reportedNotional"], "1240.7328")
        self.assertEqual(row["reportedNotionalMeaning"], "REPORTED_VALUES_PRODUCT_NOT_CASH_EXECUTED")
        self.assertTrue(row["reportedNotionalFootnoted"])
        self.assertEqual(row["footnoteReferences"]["transactionAmounts/transactionPricePerShare"], ["F1"])

    def test_derivative_price_is_not_filled_with_exercise_price(self):
        row = parse_form4(self.raw)["rows"][5]
        self.assertEqual(row["exercisePrice"], "8.125")
        self.assertEqual(row["underlyingShares"], "20")
        self.assertEqual(row["underlyingSecurityTitle"], "Common Stock")
        self.assertEqual(row["expiry"], "2030-09-04")
        self.assertIsNone(row["price"])
        self.assertIsNone(row["reportedNotional"])
        self.assertIn("NUMERIC_VALUE_UNAVAILABLE", [warning["code"] for warning in row["warnings"]])

    def test_document_checkbox_is_not_claimed_for_each_row(self):
        parsed = parse_form4(self.raw)
        self.assertTrue(parsed["aff10b5One"])
        self.assertEqual(parsed["aff10b5OneScope"], "DOCUMENT_ONLY_NOT_ROW_ATTRIBUTION")
        self.assertTrue(all("aff10b5One" not in row for row in parsed["rows"]))
        for xml, expected in [("<aff10b5One>0</aff10b5One>", False), ("", None),
                              ("<aff10b5One>maybe</aff10b5One>", None)]:
            with self.subTest(xml=xml):
                parsed = self.parse_changed("<aff10b5One>1</aff10b5One>", xml)
                self.assertIs(parsed["aff10b5One"], expected)

    def test_amendment_is_separate_and_not_netted(self):
        parsed = self.parse_changed("<documentType>4</documentType>",
                                    "<documentType>4/A</documentType><dateOfOriginalSubmission>2026-09-06</dateOfOriginalSubmission>")
        self.assertTrue(parsed["isAmendment"])
        self.assertEqual(parsed["dateOfOriginalSubmission"], "2026-09-06")
        self.assertEqual(len(parsed["rows"]), 7)
        self.assertEqual(parsed["rows"][0]["shares"], "100.5")

    def test_decimal_product_ignores_ambient_low_precision(self):
        old_precision = getcontext().prec
        try:
            getcontext().prec = 3
            parsed = self.parse_changed("<value>100.5</value>", "<value>123456789012345678901234567890.123456789</value>")
        finally:
            getcontext().prec = old_precision
        self.assertEqual(parsed["rows"][0]["reportedNotional"], "1524148134430814813443081481344.3081481342784")

    def test_invalid_numbers_do_not_become_zero_or_leak_nonfinite_json(self):
        for value in ["NaN", "Infinity", "-1", "1e200", "1,000", "12USD", "1" * 1025]:
            with self.subTest(value=value[:30]):
                parsed = self.parse_changed("<value>12.3456</value>", f"<value>{value}</value>")
                row = parsed["rows"][0]
                self.assertIsNone(row["price"])
                self.assertIsNone(row["reportedNotional"])
                self.assertIn("INVALID_NONNEGATIVE_DECIMAL", [warning["code"] for warning in row["warnings"]])

    def test_supported_decimal_notation_remains_exact(self):
        for value, expected in [("+00012.3400", "12.34"), (".5", "0.5"), ("0.0000", "0"), ("12.", "12")]:
            with self.subTest(value=value):
                row = self.parse_changed("<value>12.3456</value>", f"<value>{value}</value>")["rows"][0]
                self.assertEqual(row["price"], expected)

    def test_unknown_and_compound_codes_are_not_invented_buy_signals(self):
        for code in ["G", "J", "P/K", "NEW"]:
            row = self.parse_changed("<transactionCode>P</transactionCode>", f"<transactionCode>{code}</transactionCode>")["rows"][0]
            self.assertEqual(row["code"], code)
            self.assertEqual(row["classification"], "OTHER_CODE")

    def test_code_and_direction_disagreement_remains_visible(self):
        row = self.parse_changed("<transactionAcquiredDisposedCode><value>A</value>",
                                 "<transactionAcquiredDisposedCode><value>D</value>")["rows"][0]
        self.assertEqual(row["acquiredDisposed"], "D")
        self.assertIn("CODE_DIRECTION_CONFLICT", [warning["code"] for warning in row["warnings"]])

    def test_namespace_and_utf16_input(self):
        namespaced = self.raw.replace(b"<ownershipDocument>", b'<ownershipDocument xmlns="urn:sec:ownership">', 1)
        parsed = parse_form4(namespaced)
        self.assertEqual(len(parsed["rows"]), 7)
        utf16 = self.raw.decode().replace('encoding="UTF-8"', 'encoding="UTF-16"').encode("utf-16")
        self.assertEqual(parse_form4(utf16)["issuer"]["cik"], "0000123456")

    def test_missing_and_duplicate_footnotes_cannot_appear_resolved(self):
        parsed = self.parse_changed('<footnoteId id="F1"/>', '<footnoteId id="MISSING"/>')
        self.assertIn("UNRESOLVED_FOOTNOTE", [warning["code"] for warning in parsed["rows"][0]["warnings"]])
        parsed = self.parse_changed("</footnotes>", '<footnote id="F1">Different body</footnote></footnotes>')
        self.assertEqual(len(parsed["footnotes"]), 6)
        self.assertIn("AMBIGUOUS_FOOTNOTE_DEFINITION", [warning["code"] for warning in parsed["warnings"]])
        self.assertIn("UNRESOLVED_FOOTNOTE", [warning["code"] for warning in parsed["rows"][0]["warnings"]])

    def test_all_row_field_footnote_associations_and_unknown_xml_survive(self):
        parsed = self.parse_changed("</ownershipDocument>", '<extension source="synthetic"><futureField>do not discard</futureField></extension></ownershipDocument>')
        self.assertIn("do not discard", parsed["rawXml"])
        refs = parsed["footnoteReferences"]
        self.assertEqual(refs["nonDerivativeTable/nonDerivativeTransaction[0]/transactionAmounts/transactionPricePerShare"], ["F1"])
        self.assertEqual(refs["nonDerivativeTable/nonDerivativeTransaction[2]/transactionCoding"], ["F2"])
        self.assertEqual(parsed["rows"][4]["footnoteReferences"]["ownershipNature/natureOfOwnership"], ["F3"])

    def test_original_byte_digest_and_reporting_date_preserved(self):
        parsed = parse_form4(self.raw)
        self.assertEqual(parsed["rawSha256"], hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(parsed["periodOfReport"], "2026-09-04")
        self.assertEqual(parsed["rows"][0]["transactionDate"], "2026-09-04")
        self.assertEqual(parsed["rows"][0]["deemedExecutionDate"], "2026-09-04")
        ET.fromstring(parsed["rawXml"])

    def test_invalid_calendar_dates_are_not_accepted(self):
        parsed = self.parse_changed("<periodOfReport>2026-09-04</periodOfReport>",
                                    "<periodOfReport>2026-02-30</periodOfReport>")
        self.assertIsNone(parsed["periodOfReport"])
        self.assertIn("INVALID_DATE", [warning["code"] for warning in parsed["warnings"]])

    def test_invalid_owner_is_retained_without_corrupting_issuer_identity(self):
        parsed = self.parse_changed("<rptOwnerCik>900001</rptOwnerCik>", "<rptOwnerCik>bad</rptOwnerCik>")
        self.assertIsNone(parsed["owners"][0]["cik"])
        self.assertEqual(parsed["issuer"]["cik"], "0000123456")
        self.assertIn("bad", parsed["owners"][0]["rawXml"])

    def test_empty_form4_is_retained_with_missing_owner_warning(self):
        raw = b"<ownershipDocument><documentType>4</documentType><issuer><issuerCik>1</issuerCik></issuer></ownershipDocument>"
        parsed = parse_form4(raw)
        self.assertEqual(parsed["rows"], [])
        self.assertIn("NO_REPORTING_OWNERS", [warning["code"] for warning in parsed["warnings"]])

    def test_no_nonform4_or_invalid_identity_input(self):
        cases = [b"", b"<html/>", b"not xml", self.raw.replace(b"<documentType>4</documentType>", b"<documentType>3</documentType>")]
        for cik in ["", "0", "-1", "001A", "12345678901"]:
            cases.append(self.raw.replace(b"<issuerCik>123456</issuerCik>", f"<issuerCik>{cik}</issuerCik>".encode()))
        for raw in cases:
            with self.subTest(raw=raw[:70]), self.assertRaises(ValueError):
                parse_form4(raw)

    def test_duplicate_scalar_identity_or_amount_is_rejected(self):
        cases = [self.raw.replace(b"<issuerCik>123456</issuerCik>", b"<issuerCik>123456</issuerCik><issuerCik>999</issuerCik>"),
                 self.raw.replace(b"<value>100.5</value>", b"<value>100.5</value><value>999</value>", 1)]
        for raw in cases:
            with self.subTest(raw=raw[:70]), self.assertRaises(ValueError):
                parse_form4(raw)

    def test_dtd_entities_rejected_in_utf8_and_utf16(self):
        for doctype in ['<!DOCTYPE ownershipDocument SYSTEM "file:///etc/passwd">',
                        '<!DOCTYPE ownershipDocument [<!ENTITY x "expanded">]>']:
            xml = '<?xml version="1.0"?>' + doctype + '<ownershipDocument><documentType>4</documentType><issuer><issuerCik>1</issuerCik></issuer></ownershipDocument>'
            for encoding in ["utf-8", "utf-16"]:
                with self.subTest(doctype=doctype, encoding=encoding), self.assertRaises(ValueError):
                    parse_form4(xml.encode(encoding))

    def test_external_entity_without_declaration_is_malformed(self):
        with self.assertRaises(ValueError):
            parse_form4(self.raw.replace(b"Synthetic Example Corporation", b"&external;"))

    def test_size_and_depth_limits_are_enforced(self):
        with self.assertRaises(ValueError):
            parse_form4(b" " * (MAX_XML_BYTES + 1))
        depth = MAX_XML_DEPTH + 1
        with self.assertRaises(ValueError):
            parse_form4(b"<a>" * depth + b"</a>" * depth)

    def test_input_must_be_bytes(self):
        with self.assertRaises(ValueError):
            parse_form4(self.raw.decode())


if __name__ == "__main__":
    unittest.main()
